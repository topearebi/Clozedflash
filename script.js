// ==========================================
// 1. DATABASE (Dexie)
// ==========================================
// We initialize this in the init block to handle missing library errors gracefully, 
// but we define the variable here.
let db;

// ==========================================
// 2. LOGIC & GAMIFICATION
// ==========================================
const Logic = {
    gamification: JSON.parse(localStorage.getItem('fd7_gamification')) || { streak: 0, lastStudyDate: null, xp: 0, level: 1, sparks: 100 },
    dailyStats: JSON.parse(localStorage.getItem('fd7_daily')) || { date: new Date().toDateString(), reviews: 0, learned: 0 },

    saveState() {
        localStorage.setItem('fd7_gamification', JSON.stringify(this.gamification));
        localStorage.setItem('fd7_daily', JSON.stringify(this.dailyStats));
        UI.updateStats();
    },

    checkDailyReset() {
        const today = new Date().toDateString();
        if (this.dailyStats.date !== today) {
            this.dailyStats = { date: today, reviews: 0, learned: 0 };
        }
        const last = this.gamification.lastStudyDate;
        if (last !== today) {
            const yesterday = new Date(Date.now() - 86400000).toDateString();
            if (last !== yesterday && last !== null) this.gamification.streak = 0;
            if (last !== today) { this.addSparks(50); alert("Daily Bonus! +50 ⚡"); }
            this.gamification.lastStudyDate = today;
        }
        this.saveState();
    },

    addXP(amount) {
        this.gamification.xp += amount;
        const newLevel = Math.floor(this.gamification.xp / 1000) + 1;
        if (newLevel > this.gamification.level) { alert(`Level Up! ${newLevel} 🎉`); this.gamification.level = newLevel; }
        this.saveState();
    },

    addSparks(amount) {
        this.gamification.sparks += amount;
        this.saveState();
    },

    recordAction(type) {
        if (type === 'REVIEW') { this.dailyStats.reviews++; this.addXP(10); if(this.gamification.streak === 0) this.gamification.streak = 1; }
        if (type === 'LEARN') { this.dailyStats.learned++; this.addXP(20); }
        this.saveState();
    },

    isCJK(text) { return /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff66-\uff9f]/.test(text); },

    calculateNextReview(card, rating) {
        let nextInterval = 0;
        let newLapses = card.lapses || 0;
        let lockedIndex = card.lockedIndex; 

        if (rating === 0) { nextInterval = 0; newLapses++; } 
        else {
            const mult = [0, 1.2, 2.5, 4.0];
            const currentInt = card.interval || 0;
            nextInterval = Math.ceil(Math.max(1, currentInt * mult[rating]));
            lockedIndex = null; 
        }
        return { interval: nextInterval, dueDate: Date.now() + (nextInterval * 24 * 60 * 60 * 1000), lapses: newLapses, status: newLapses >= 5 ? 'LEECH' : 'ACTIVE', lockedIndex };
    }
};

// ==========================================
// 3. AUDIO SERVICE
// ==========================================
const AudioService = {
    recorder: null, chunks: [],
    
    async startRecording() {
        if (!navigator.mediaDevices) return alert("Microphone not supported.");
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            this.recorder = new MediaRecorder(stream);
            this.chunks = [];
            this.recorder.ondataavailable = e => this.chunks.push(e.data);
            this.recorder.start();
            return true;
        } catch (e) { console.error(e); alert("Mic Error. Ensure HTTPS or Localhost."); return false; }
    },

    stopRecording() {
        return new Promise(resolve => {
            if (!this.recorder) return resolve(null);
            this.recorder.onstop = () => { resolve(new Blob(this.chunks, { type: 'audio/webm' })); };
            this.recorder.stop();
        });
    },

    handleFileUpload(fileInput) {
        return new Promise(resolve => {
            const file = fileInput.files[0];
            if (!file) return resolve(null);
            resolve(file); 
        });
    },

    async play(blobOrText) {
        if (!blobOrText) return;
        if (blobOrText instanceof Blob) {
            const url = URL.createObjectURL(blobOrText);
            const audio = new Audio(url);
            audio.play();
        } else if (typeof blobOrText === 'string') {
            const u = new SpeechSynthesisUtterance(blobOrText);
            u.lang = Logic.isCJK(blobOrText) ? 'zh-CN' : 'en-US';
            window.speechSynthesis.speak(u);
        }
    },

    async saveAudio(blob, cardId=null, segmentId=null) {
        if (!blob) return;
        try { await db.audio.add({ blob, cardId, segmentId }); }
        catch(e) { console.error("Audio Save Failed", e); }
    },

    async getAudioForCard(cardId) {
        const record = await db.audio.where('cardId').equals(cardId).first();
        return record ? record.blob : null;
    }
};

// ==========================================
// 4. UI CONTROLLER
// ==========================================
const UI = {
    showTab(tabId) {
        document.querySelectorAll('section').forEach(el => { el.classList.remove('active-view'); el.classList.add('hidden-view'); });
        document.getElementById(tabId).classList.remove('hidden-view');
        document.getElementById(tabId).classList.add('active-view');
        document.querySelectorAll('.nav-item').forEach

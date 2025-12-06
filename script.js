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
        document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
        document.querySelector(`.nav-item[data-target="${tabId}"]`).classList.add('active');

        if (tabId === 'view-home') Dashboard.refresh();
        if (tabId === 'view-read') Library.refresh();
        if (tabId === 'view-browse') Deck.refresh();
        if (tabId === 'view-settings') Settings.refresh();
    },
    updateStats() {
        document.getElementById('credit-count').textContent = Logic.gamification.sparks;
        document.getElementById('stat-streak').textContent = Logic.gamification.streak;
        document.getElementById('stat-level').textContent = Logic.gamification.level;
        document.getElementById('daily-reviews').textContent = Logic.dailyStats.reviews;
        document.getElementById('daily-learned').textContent = Logic.dailyStats.learned;
    },
    toggleOverlay(id, show) {
        const el = document.getElementById(id);
        if (show) el.classList.remove('hidden'); else el.classList.add('hidden');
    }
};

// ==========================================
// 5. DASHBOARD
// ==========================================
const Dashboard = {
    async refresh() {
        const now = Date.now();
        const dueCount = await db.cards.where('dueDate').belowOrEqual(now).count();
        const newCount = await db.cards.where('status').equals('NEW').count();
        const masteredCount = await db.cards.where('interval').above(21).count();

        document.getElementById('total-mastered').textContent = masteredCount;
        
        const box = document.querySelector('.stats-box');
        const btn = document.getElementById('btn-action-main');
        const count = document.getElementById('dashboard-count');
        const heading = document.getElementById('status-heading');

        if (dueCount > 0) {
            box.className = 'stats-box'; heading.textContent = "Reviews Due"; count.textContent = dueCount;
            btn.textContent = "Review Now"; btn.onclick = () => StudySession.start('DUE');
        } else if (newCount > 0) {
            box.className = 'stats-box green'; heading.textContent = "New Cards"; count.textContent = newCount;
            const batch = Math.min(10, newCount); btn.textContent = `Learn New (+${batch})`;
            btn.onclick = () => StudySession.start('NEW', batch);
        } else {
            box.className = 'stats-box orange'; heading.textContent = "All Caught Up"; count.textContent = "0";
            btn.textContent = "Cram Mode"; btn.onclick = () => document.getElementById('modal-cram-settings').classList.remove('hidden');
        }
        
        const recent = await db.chapters.orderBy('id').reverse().limit(3).toArray();
        document.getElementById('home-activity-list').innerHTML = recent.map(c => `
            <div class="chapter-item" onclick="Reader.open(${c.id})"><span class="item-main">${c.title}</span><span class="item-sub">${c.segments.length} lines</span></div>
        `).join('');
    }
};

// ==========================================
// 6. STUDY SESSION
// ==========================================
const StudySession = {
    queue: [], current: null,
    async start(mode, batchSize=10) {
        if (mode === 'DUE') {
            this.queue = await db.cards.where('dueDate').belowOrEqual(Date.now()).toArray();
        } else if (mode === 'NEW') {
            this.queue = await db.cards.where('status').equals('NEW').limit(batchSize).toArray();
            this.queue.forEach(c => c.status = 'ACTIVE');
        }
        if (this.queue.length === 0) return alert("Nothing to study!");
        UI.toggleOverlay('overlay-study', true);
        this.loadNext();
    },
    async loadNext() {
        if (this.queue.length === 0) {
            alert("Session Complete!"); UI.toggleOverlay('overlay-study', false); Dashboard.refresh(); return;
        }
        this.current = this.queue[0];
        document.getElementById('study-progress').textContent = `${this.queue.length} Left`;
        
        document.getElementById('study-answer').classList.add('hidden');
        document.getElementById('study-cloze-area').classList.add('hidden');
        document.getElementById('study-sub-text').classList.add('hidden');
        document.getElementById('btn-show-hint').classList.add('hidden');
        
        const badge = document.getElementById('study-tag-badge');
        badge.textContent = this.current.tag || "";
        badge.classList.toggle('hidden', !this.current.tag);
        
        const audioBlob = await AudioService.getAudioForCard(this.current.id);
        document.getElementById('btn-play-audio').onclick = () => AudioService.play(audioBlob || this.current.target);

        if (this.current.type === 'SENTENCE') this.renderCloze();
        else { if (Math.random() > 0.3) this.renderRecog(); else this.renderRecall(); }
    },
    renderRecog() {
        document.getElementById('study-hint-label').textContent = "Translate to Native:";
        document.getElementById('study-main-text').textContent = this.current.target;
        document.getElementById('study-main-text').onclick = () => this.reveal();
    },
    renderRecall() {
        document.getElementById('study-hint-label').textContent = "Translate to Target:";
        document.getElementById('study-main-text').textContent = this.current.native;
        if(this.current.meta) {
            const btn = document.getElementById('btn-show-hint');
            btn.classList.remove('hidden');
            btn.onclick = () => { document.getElementById('study-sub-text').textContent = this.current.meta; document.getElementById('study-sub-text').classList.remove('hidden'); };
        }
        document.getElementById('study-main-text').onclick = () => this.reveal();
    },
    renderCloze() {
        document.getElementById('study-hint-label').textContent = this.current.native;
        const isChinese = Logic.isCJK(this.current.target);
        let words = isChinese ? this.current.target.split('') : this.current.target.split(' ');
        
        let index;
        if (this.current.lockedIndex !== null && this.current.lockedIndex !== undefined) index = this.current.lockedIndex;
        else index = Math.floor(Math.random() * words.length);
        
        this.current.tempIndex = index;
        const answer = words[index];
        words[index] = "___";
        
        document.getElementById('study-main-text').textContent = words.join(isChinese ? '' : ' ');
        document.getElementById('study-main-text').onclick = null;
        
        document.getElementById('study-cloze-area').classList.remove('hidden');
        const input = document.getElementById('cloze-answer');
        input.value = ''; input.focus();
        
        document.getElementById('btn-check-cloze').onclick = () => {
            if (input.value.trim().toLowerCase() === answer.toLowerCase()) {
                input.classList.add('input-correct'); setTimeout(() => this.reveal(), 500);
            } else {
                input.classList.add('input-wrong'); setTimeout(() => this.reveal(), 1000);
            }
        };
    },
    reveal() {
        document.getElementById('study-answer').classList.remove('hidden');
        document.getElementById('ans-target').textContent = this.current.target;
        document.getElementById('ans-meta').textContent = this.current.meta || "";
        document.getElementById('ans-native').textContent = this.current.native;
    },
    async rate(rating) {
        if (this.current.type === 'SENTENCE' && rating === 0) this.current.lockedIndex = this.current.tempIndex;
        const res = Logic.calculateNextReview(this.current, rating);
        await db.cards.update(this.current.id, { interval: res.interval, dueDate: res.dueDate, lapses: res.lapses, status: res.status, lockedIndex: res.lockedIndex });
        if(this.current.dueDate === null) Logic.recordAction('LEARN'); else Logic.recordAction('REVIEW');
        if (rating === 0) this.queue.push(this.current);
        this.queue.shift();
        this.loadNext();
    }
};

// ==========================================
// 7. STREAM BUILDER
// ==========================================
const StreamBuilder = {
    segments: [], tempBlob: null,
    init() { this.segments = []; document.getElementById('builder-stream').innerHTML = '<div class="empty-state">Start adding...</div>'; },
    async toggleRecord() { 
        const btn = document.getElementById('btn-record');
        if (btn.classList.contains('recording')) { 
            btn.classList.remove('recording'); this.tempBlob = await AudioService.stopRecording(); btn.textContent = '✅'; 
        } else { 
            if(await AudioService.startRecording()) { btn.classList.add('recording'); btn.textContent = '⏹'; } 
        }
    },
    async handleFileSelect() { const f = document.getElementById('dock-file'); this.tempBlob = await AudioService.handleFileUpload(f); document.getElementById('file-status').classList.remove('hidden'); },
    addSegment() {
        const target = document.getElementById('dock-target').value;
        const native = document.getElementById('dock-native').value;
        const meta = document.getElementById('dock-meta').value;
        if (!target) return;
        this.segments.push({ target, native, meta, audioBlob: this.tempBlob, cardId: null });
        const div = document.createElement('div');
        div.className = 'segment-bubble';
        div.innerHTML = `<div class="segment-target">${target}</div><div class="segment-native">${native}</div>${this.tempBlob?'<span>🔊</span>':''}`;
        document.getElementById('builder-stream').appendChild(div);
        this.tempBlob = null; document.getElementById('dock-target').value = ''; document.getElementById('file-status').classList.add('hidden');
    },
    async save() {
        await db.chapters.add({ title: document.getElementById('builder-title').value, tag: document.getElementById('builder-tag').value, segments: this.segments });
        alert("Saved!"); UI.toggleOverlay('overlay-builder', false); Library.refresh();
        Logic.addXP(50);
    }
};

// ==========================================
// 8. READER & IMPORTERS
// ==========================================
const Reader = {
    currentChapter: null, showMeta: true, showNative: true,
    async open(chapterId) {
        this.currentChapter = await db.chapters.get(chapterId);
        UI.toggleOverlay('overlay-reader', true);
        this.renderText();
    },
    toggleMeta() { this.showMeta = !this.showMeta; document.getElementById('btn-toggle-meta').classList.toggle('active', this.showMeta); this.renderText(); },
    toggleNative() { this.showNative = !this.showNative; document.getElementById('btn-toggle-native').classList.toggle('active', this.showNative); this.renderText(); },
    async renderText() {
        const container = document.getElementById('reader-content');
        container.innerHTML = '';
        this.currentChapter.segments.forEach((seg, index) => {
            const span = document.createElement('span');
            span.className = 'reader-segment ' + (seg.cardId ? 'known' : 'unknown');
            let text = seg.target;
            if (this.showMeta && seg.meta) text += ` (${seg.meta})`;
            if (this.showNative && seg.native) text += `\n[${seg.native}]`;
            span.innerText = text + (Logic.isCJK(seg.target) ? '' : ' ');
            span.onclick = () => this.openSheet(seg, index);
            container.appendChild(span);
        });
        document.getElementById('btn-reader-play').onclick = () => this.playAll();
    },
    async playAll() {
        for (const seg of this.currentChapter.segments) { await AudioService.play(seg.audioBlob || seg.target); await new Promise(r => setTimeout(r, 2000)); }
    },
    openSheet(seg, index) {
        const sheet = document.getElementById('reader-sheet');
        sheet.classList.remove('hidden');
        document.getElementById('sheet-target').textContent = seg.target;
        document.getElementById('sheet-native').textContent = seg.native;
        document.getElementById('btn-sheet-play').onclick = () => AudioService.play(seg.audioBlob || seg.target);
        const btnPromote = document.getElementById('btn-sheet-promote');
        if (seg.cardId) { btnPromote.textContent = "✓ Already in Deck"; btnPromote.disabled = true; }
        else { btnPromote.textContent = "Promote to Card"; btnPromote.disabled = false; btnPromote.onclick = () => this.promote(seg, index); }
    },
    async promote(seg, index) {
        const cardId = await db.cards.add({ type: 'SENTENCE', target: seg.target, native: seg.native, meta: seg.meta, tag: this.currentChapter.tag, status: 'NEW', dueDate: null, interval: 0, lapses: 0 });
        if (seg.audioBlob) await AudioService.saveAudio(seg.audioBlob, cardId);
        this.currentChapter.segments[index].cardId = cardId;
        await db.chapters.put(this.currentChapter);
        alert("Promoted!"); this.renderText(); document.getElementById('reader-sheet').classList.add('hidden'); Logic.addXP(20);
    }
};

const Importer = {
    async runCardImport() {
        const raw = document.getElementById('input-bulk').value;
        const tag = document.getElementById('input-bulk-tag').value;
        if (!raw.trim()) return;
        const lines = raw.split('\n');
        let count = 0;
        const delimiter = raw.indexOf('\t') !== -1 ? '\t' : ',';
        for (const line of lines) {
            if (!line.trim()) continue;
            let parts = line.split(delimiter).map(s => s.trim());
            if (parts.length < 2 || parts[0].toLowerCase().includes('target')) continue;
            let target = parts[0], meta = parts.length > 2 ? parts[1] : "", native = parts.length > 2 ? parts[2] : parts[1];
            let type = 'VOCAB';
            if (Logic.isCJK(target)) { if (/[。？！，,?!]/.test(target)) type = 'SENTENCE'; } else { if (target.split(' ').length > 3) type = 'SENTENCE'; }
            await db.cards.add({ type, target, meta, native, tag, status: 'NEW', dueDate: null, interval: 0, lapses: 0 });
            count++;
        }
        alert(`Imported ${count} cards!`); document.getElementById('modal-import').classList.add('hidden'); Logic.addXP(count * 5); Dashboard.refresh();
    },
    async runChapterImport() {
        const title = document.getElementById('imp-chap-title').value, tag = document.getElementById('imp-chap-tag').value, raw = document.getElementById('imp-chap-data').value;
        if (!title || !raw) return alert("Title and Data required");
        const lines = raw.split('\n'), segments = [], delimiter = raw.indexOf('\t') !== -1 ? '\t' : ',';
        lines.forEach(line => {
            if (!line.trim()) return;
            let parts = line.split(delimiter).map(s => s.trim()), target = parts[0], meta = "", native = "";
            if (parts.length === 2) native = parts[1]; else if (parts.length >= 3) { meta = parts[1]; native = parts[2]; }
            segments.push({ target, meta, native, audioBlob: null, cardId: null });
        });
        await db.chapters.add({ title, tag, segments });
        alert(`Chapter "${title}" created!`); document.getElementById('modal-import-chapter').classList.add('hidden'); Logic.addXP(50); Library.refresh();
    }
};

const Library = {
    async refresh() {
        const list = await db.chapters.toArray();
        document.getElementById('chapter-list').innerHTML = list.map(c => `<div class="chapter-item" onclick="Reader.open(${c.id})"><span class="item-main">${c.title}</span><span class="item-sub">${c.segments.length} segs</span></div>`).join('');
    }
};

const Deck = {
    async refresh() {
        const q = document.getElementById('search-bar').value.toLowerCase();
        let list;
        if(q) list = await db.cards.filter(c => c.target.toLowerCase().includes(q) || c.native.toLowerCase().includes(q)).toArray();
        else list = await db.cards.limit(50).toArray(); 
        document.getElementById('card-list').innerHTML = list.map(c => `<div class="card-item"><div><span class="item-main">${c.target}</span><br><span class="item-sub">${c.native}</span></div><div><button class="small-btn" onclick="Deck.delete(${c.id})">🗑</button></div></div>`).join('');
    },
    async delete(id) { if(confirm("Delete card?")) { await db.cards.delete(id); this.refresh(); Dashboard.refresh(); } }
};

const Settings = { refresh() { document.getElementById('setting-xp').textContent = Logic.gamification.xp; } };

const Game = {
    queue: [], round: 1, speed: 3000, timer: null, phase: 'WATCH', index: 0, score: 0,
    async start() {
        const count = await db.cards.count();
        if (count < 5) return alert("Need 5+ cards!");
        this.round = 1; this.runRound();
    },
    async runRound() {
        const all = await db.cards.toArray();
        this.queue = this.shuffle(all).slice(0, 10);
        this.speed = Math.floor(Math.max(250, 3000 * Math.pow(0.8, this.round - 1)));
        this.phase = 'WATCH'; this.index = 0; UI.toggleOverlay('view-game', true);
        document.getElementById('game-status').textContent = `Round ${this.round} (${this.speed}ms)`;
        document.getElementById('game-input-area').classList.add('hidden');
        this.playWatch();
    },
    shuffle(a) { return a.sort(() => Math.random() - 0.5); },
    playWatch() {
        if (this.index >= this.queue.length) { this.startTest(); return; }
        const c = this.queue[this.index];
        document.getElementById('game-card-content').innerHTML = `<h2>${c.target}</h2><p>${c.native}</p>`;
        this.timer = setTimeout(() => { this.index++; this.playWatch(); }, this.speed);
    },
    startTest() {
        this.phase = 'TEST'; this.index = 0; this.score = 0;
        document.getElementById('game-status').textContent = "TEST!";
        document.getElementById('game-input-area').classList.remove('hidden');
        this.nextTest();
    },
    nextTest() {
        if (this.index >= this.queue.length) { this.endRound(); return; }
        document.getElementById('game-card-content').innerHTML = `<h2>${this.queue[this.index].target}</h2>`;
        document.getElementById('game-input').value = ''; document.getElementById('game-input').focus();
    },
    check() {
        const val = document.getElementById('game-input').value.toLowerCase();
        const ans = this.queue[this.index].native.toLowerCase();
        if(val === ans || (val.length > 2 && ans.includes(val))) {
            this.score++; this.index++; this.nextTest();
        } else {
            alert(`Wrong! Answer: ${ans}`); this.index++; this.nextTest();
        }
    },
    endRound() {
        if (this.score >= 8) { 
            Logic.addSparks(10);
            if(confirm("Next Round?")) { this.round++; this.runRound(); } else UI.toggleOverlay('view-game', false); 
        }
        else { alert(`Game Over. Score: ${this.score}`); UI.toggleOverlay('view-game', false); }
    }
};

// ==========================================
// 10. INITIALIZATION & LISTENERS
// ==========================================
function setupEventListeners() {
    document.querySelectorAll('.nav-item').forEach(btn => btn.onclick = () => UI.showTab(btn.dataset.target));

    // Overlays
    document.getElementById('btn-new-chapter').onclick = () => { StreamBuilder.init(); UI.toggleOverlay('overlay-builder', true); };
    document.getElementById('btn-quit-builder').onclick = () => UI.toggleOverlay('overlay-builder', false);
    document.getElementById('btn-quit-study').onclick = () => { UI.toggleOverlay('overlay-study', false); Dashboard.refresh(); };
    document.getElementById('btn-quit-reader').onclick = () => UI.toggleOverlay('overlay-reader', false);
    document.getElementById('btn-quit-game').onclick = () => UI.toggleOverlay('view-game', false);
    document.getElementById('btn-add-card').onclick = () => document.getElementById('modal-add-card').classList.remove('hidden');
    document.getElementById('btn-qa-cancel').onclick = () => document.getElementById('modal-add-card').classList.add('hidden');

    // Builder
    document.getElementById('btn-record').onclick = () => StreamBuilder.toggleRecord();
    document.getElementById('dock-file').onchange = () => StreamBuilder.handleFileSelect();
    document.getElementById('btn-add-segment').onclick = () => StreamBuilder.addSegment();
    document.getElementById('btn-save-chapter').onclick = () => StreamBuilder.save();

    // Reader & Import
    document.getElementById('btn-toggle-meta').onclick = () => Reader.toggleMeta();
    document.getElementById('btn-toggle-native').onclick = () => Reader.toggleNative();
    document.getElementById('btn-open-import').onclick = () => document.getElementById('modal-import').classList.remove('hidden');
    document.getElementById('btn-cancel-import').onclick = () => document.getElementById('modal-import').classList.add('hidden');
    document.getElementById('btn-run-import').onclick = () => Importer.runCardImport();
    document.getElementById('btn-import-chapter').onclick = () => document.getElementById('modal-import-chapter').classList.remove('hidden');
    document.getElementById('btn-cancel-imp-chap').onclick = () => document.getElementById('modal-import-chapter').classList.add('hidden');
    document.getElementById('btn-run-imp-chap').onclick = () => Importer.runChapterImport();

    // Search
    document.getElementById('search-bar').addEventListener('input', () => Deck.refresh());

    // Game
    document.getElementById('btn-game').onclick = () => Game.start();
    document.getElementById('btn-game-submit').onclick = () => Game.check();

    // Quick Add
    document.getElementById('form-quick-add').onsubmit = async (e) => {
        e.preventDefault();
        const fileInput = document.getElementById('qa-file');
        let blob = null;
        if(fileInput.files.length) blob = fileInput.files[0];
        const cardId = await db.cards.add({ target: document.getElementById('qa-target').value, native: document.getElementById('qa-native').value, meta: document.getElementById('qa-meta').value, tag: document.getElementById('qa-tag').value, type: 'VOCAB', status: 'NEW', dueDate: null });
        if(blob) await AudioService.saveAudio(blob, cardId);
        document.getElementById('modal-add-card').classList.add('hidden'); alert("Saved!"); Dashboard.refresh(); Logic.addXP(20);
    };

    // Cram
    document.getElementById('btn-start-cram').onclick = () => {
        if(Logic.gamification.sparks < 50) return alert("Need 50 ⚡");
        Logic.addSparks(-50);
        document.getElementById('modal-cram-settings').classList.add('hidden');
        StudySession.start('NEW', 50); // Fallback for cram logic
    };

    // Ratings
    document.querySelectorAll('.rate-btn').forEach(btn => btn.onclick = () => StudySession.rate(parseInt(btn.dataset.rating)));

    // Reset & Backup
    document.getElementById('btn-clear-db').onclick = async () => { if(confirm("Destroy Data?")) { await Dexie.delete('FlashDeckDB_v7'); location.reload(); }};
    document.getElementById('btn-backup').onclick = async () => {
        const zip = new JSZip();
        const allCards = await db.cards.toArray();
        const allChapters = await db.chapters.toArray();
        zip.file("database.json", JSON.stringify({ cards: allCards, chapters: allChapters }));
        zip.generateAsync({type:"blob"}).then(content => {
            const a = document.createElement('a'); a.href = URL.createObjectURL(content); a.download = "backup.zip"; a.click();
        });
    };
}

// === MAIN INIT ===
document.addEventListener('DOMContentLoaded', async () => {
    try {
        if (typeof Dexie === 'undefined' || typeof JSZip === 'undefined') {
            throw new Error("Missing Libraries! Ensure dexie.js and jszip.min.js are in your folder.");
        }
        
        Logic.checkDailyReset();
        UI.updateStats();
        
        // Wait for DB to be ready
        await Dashboard.refresh();
        setupEventListeners();
        console.log("App Ready");

    } catch (e) {
        alert("Startup Error: " + e.message + "\n\nSee console for details.");
        console.error(e);
        // DB Version Mismatch Fallback
        if (e.name === 'VersionError' && confirm("Database Version Error. Reset DB?")) {
            await Dexie.delete('FlashDeckDB_v7');
            location.reload();
        }
    }
});

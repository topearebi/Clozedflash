// ==========================================
// 1. DATABASE SERVICE (IndexedDB via Dexie)
// ==========================================
const db = new Dexie('FlashDeckDB_v6');
db.version(1).stores({
    cards: '++id, type, tag, status, dueDate', // status: NEW, ACTIVE, LEECH
    chapters: '++id, title, tag',
    audio: '++id, cardId, segmentId' // Stores binary blobs
});

// ==========================================
// 2. AUDIO SERVICE
// ==========================================
const AudioService = {
    recorder: null,
    chunks: [],
    
    async startRecording() {
        if (!navigator.mediaDevices) return alert("Microphone not supported/allowed.");
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            this.recorder = new MediaRecorder(stream);
            this.chunks = [];
            this.recorder.ondataavailable = e => this.chunks.push(e.data);
            this.recorder.start();
            return true;
        } catch (e) {
            console.error(e);
            alert("Mic Error. Use HTTPS or Localhost.");
            return false;
        }
    },

    stopRecording() {
        return new Promise(resolve => {
            if (!this.recorder) return resolve(null);
            this.recorder.onstop = () => {
                const blob = new Blob(this.chunks, { type: 'audio/webm' });
                resolve(blob);
            };
            this.recorder.stop();
        });
    },

    // Handle File Upload from <input type="file">
    handleFileUpload(fileInput) {
        return new Promise(resolve => {
            const file = fileInput.files[0];
            if (!file) return resolve(null);
            resolve(file); // File object is a Blob
        });
    },

    async play(blobOrText) {
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
        await db.audio.add({ blob, cardId, segmentId });
    },

    async getAudioForCard(cardId) {
        const record = await db.audio.where('cardId').equals(cardId).first();
        return record ? record.blob : null;
    }
};

// ==========================================
// 3. LOGIC SERVICE
// ==========================================
const Logic = {
    userCredits: parseInt(localStorage.getItem('fd6_credits')) || 100,

    isCJK(text) {
        return /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff66-\uff9f]/.test(text);
    },

    addCredits(amount) {
        this.userCredits += amount;
        localStorage.setItem('fd6_credits', this.userCredits);
        UI.updateCredits();
    },

    calculateNextReview(card, rating) {
        let nextInterval = 0;
        let newLapses = card.lapses || 0;
        let lockedIndex = card.lockedIndex; // Sticky Cloze logic

        if (rating === 0) {
            nextInterval = 0; // Due today
            newLapses++;
        } else {
            const mult = [0, 1.2, 2.5, 4.0];
            const currentInt = card.interval || 0;
            nextInterval = Math.ceil(Math.max(1, currentInt * mult[rating]));
            lockedIndex = null; // Clear lock on success
        }

        return {
            interval: nextInterval,
            dueDate: Date.now() + (nextInterval * 24 * 60 * 60 * 1000),
            lapses: newLapses,
            status: newLapses >= 5 ? 'LEECH' : 'ACTIVE',
            lockedIndex
        };
    }
};

// ==========================================
// 4. UI CONTROLLER
// ==========================================
const UI = {
    showTab(tabId) {
        document.querySelectorAll('section').forEach(el => el.classList.remove('active-view'));
        document.querySelectorAll('section').forEach(el => el.classList.add('hidden-view'));
        document.getElementById(tabId).classList.remove('hidden-view');
        document.getElementById(tabId).classList.add('active-view');
        
        document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
        document.querySelector(`.nav-item[data-target="${tabId}"]`).classList.add('active');

        if (tabId === 'view-home') Dashboard.refresh();
        if (tabId === 'view-read') Library.refresh();
        if (tabId === 'view-browse') Deck.refresh();
    },
    updateCredits() { document.getElementById('credit-count').textContent = Logic.userCredits; },
    toggleOverlay(id, show) {
        const el = document.getElementById(id);
        if (show) el.classList.remove('hidden');
        else el.classList.add('hidden');
    }
};

// ==========================================
// 5. MODULE: DASHBOARD
// ==========================================
const Dashboard = {
    async refresh() {
        const now = Date.now();
        const dueCount = await db.cards.where('dueDate').belowOrEqual(now).count();
        const newCount = await db.cards.where('status').equals('NEW').count();
        
        const box = document.querySelector('.stats-box');
        const btn = document.getElementById('btn-action-main');
        const count = document.getElementById('dashboard-count');
        const heading = document.getElementById('status-heading');

        if (dueCount > 0) {
            box.className = 'stats-box'; 
            heading.textContent = "Reviews Due";
            count.textContent = dueCount;
            btn.textContent = "Review Now";
            btn.onclick = () => StudySession.start('DUE');
        } else if (newCount > 0) {
            box.className = 'stats-box green';
            heading.textContent = "New Cards";
            count.textContent = newCount;
            const batch = Math.min(10, newCount);
            btn.textContent = `Learn New (+${batch})`;
            btn.onclick = () => StudySession.start('NEW', batch);
        } else {
            box.className = 'stats-box orange';
            heading.textContent = "All Caught Up";
            count.textContent = "0";
            btn.textContent = "Cram Mode";
            btn.onclick = () => document.getElementById('modal-cram-settings').classList.remove('hidden');
        }
        
        const recent = await db.chapters.orderBy('id').reverse().limit(3).toArray();
        document.getElementById('home-activity-list').innerHTML = recent.map(c => `
            <div class="chapter-item" onclick="Reader.open(${c.id})">
                <span class="item-main">${c.title}</span>
                <span class="item-sub">${c.segments.length} segs</span>
            </div>
        `).join('');
    }
};

// ==========================================
// 6. MODULE: STUDY SESSION
// ==========================================
const StudySession = {
    queue: [],
    current: null,
    
    async start(mode, batchSize=10) {
        if (mode === 'DUE') {
            this.queue = await db.cards.where('dueDate').belowOrEqual(Date.now()).toArray();
        } else if (mode === 'NEW') {
            this.queue = await db.cards.where('status').equals('NEW').limit(batchSize).toArray();
            this.queue.forEach(c => c.status = 'ACTIVE');
        } else if (mode === 'CRAM') {
            // Filter logic handled in Cram UI logic
        }
        
        if (this.queue.length === 0) return alert("Nothing to study!");
        UI.toggleOverlay('overlay-study', true);
        this.loadNext();
    },

    async loadNext() {
        if (this.queue.length === 0) {
            alert("Session Complete!");
            UI.toggleOverlay('overlay-study', false);
            Dashboard.refresh();
            return;
        }
        
        this.current = this.queue[0];
        document.getElementById('study-progress').textContent = `${this.queue.length} Left`;
        
        // Reset UI
        document.getElementById('study-answer').classList.add('hidden');
        document.getElementById('study-cloze-area').classList.add('hidden');
        document.getElementById('study-sub-text').classList.add('hidden');
        document.getElementById('btn-show-hint').classList.add('hidden');
        
        // Tags & Audio
        const badge = document.getElementById('study-tag-badge');
        badge.textContent = this.current.tag || "";
        badge.classList.toggle('hidden', !this.current.tag);
        
        const audioBlob = await AudioService.getAudioForCard(this.current.id);
        document.getElementById('btn-play-audio').onclick = () => AudioService.play(audioBlob || this.current.target);

        // Render based on Type
        if (this.current.type === 'SENTENCE') this.renderCloze();
        else {
            // Bi-Directional: 70% Recog, 30% Recall
            if (Math.random() > 0.3) this.renderRecog();
            else this.renderRecall();
        }
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
            btn.onclick = () => {
                document.getElementById('study-sub-text').textContent = this.current.meta;
                document.getElementById('study-sub-text').classList.remove('hidden');
            };
        }
        document.getElementById('study-main-text').onclick = () => this.reveal();
    },

    renderCloze() {
        document.getElementById('study-hint-label').textContent = this.current.native;
        const isChinese = Logic.isCJK(this.current.target);
        let words = isChinese ? this.current.target.split('') : this.current.target.split(' ');
        
        // Sticky Logic: use lockedIndex if available
        let index;
        if (this.current.lockedIndex !== null && this.current.lockedIndex !== undefined) {
             index = this.current.lockedIndex;
        } else {
             index = Math.floor(Math.random() * words.length);
        }
        
        this.current.tempIndex = index; // Store for this turn
        const answer = words[index];
        words[index] = "___";
        
        document.getElementById('study-main-text').textContent = words.join(isChinese ? '' : ' ');
        document.getElementById('study-main-text').onclick = null;
        
        const inputDiv = document.getElementById('study-cloze-area');
        inputDiv.classList.remove('hidden');
        const input = document.getElementById('cloze-answer');
        input.value = '';
        input.focus();
        
        document.getElementById('btn-check-cloze').onclick = () => {
            if (input.value.trim().toLowerCase() === answer.toLowerCase()) {
                input.classList.add('input-correct');
                setTimeout(() => this.reveal(), 500);
            } else {
                input.classList.add('input-wrong');
                setTimeout(() => this.reveal(), 1000);
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
        // Handle Sticky Cloze locking
        if (this.current.type === 'SENTENCE' && rating === 0) {
            this.current.lockedIndex = this.current.tempIndex;
        }

        const res = Logic.calculateNextReview(this.current, rating);
        
        await db.cards.update(this.current.id, {
            interval: res.interval,
            dueDate: res.dueDate,
            lapses: res.lapses,
            status: res.status,
            lockedIndex: res.lockedIndex
        });

        if (rating === 0) this.queue.push(this.current); // Re-queue
        this.queue.shift();
        this.loadNext();
    }
};

// ==========================================
// 7. MODULE: STREAM BUILDER
// ==========================================
const StreamBuilder = {
    segments: [],
    tempBlob: null,

    init() {
        this.segments = [];
        this.tempBlob = null;
        document.getElementById('builder-stream').innerHTML = '<div class="empty-state">Start adding...</div>';
        document.getElementById('builder-title').value = '';
    },

    async toggleRecord() {
        const btn = document.getElementById('btn-record');
        const status = document.getElementById('recording-status');
        
        if (btn.classList.contains('recording')) {
            btn.classList.remove('recording');
            status.classList.add('hidden');
            this.tempBlob = await AudioService.stopRecording();
            btn.textContent = '✅';
        } else {
            const started = await AudioService.startRecording();
            if (started) {
                btn.classList.add('recording');
                status.classList.remove('hidden');
                btn.textContent = '⏹';
            }
        }
    },

    async handleFileSelect() {
        const fileInput = document.getElementById('dock-file');
        this.tempBlob = await AudioService.handleFileUpload(fileInput);
        if(this.tempBlob) {
            document.getElementById('file-status').textContent = "File Ready";
            document.getElementById('file-status').classList.remove('hidden');
        }
    },

    addSegment() {
        const target = document.getElementById('dock-target').value;
        const native = document.getElementById('dock-native').value;
        const meta = document.getElementById('dock-meta').value;
        if (!target) return;

        this.segments.push({ target, native, meta, audioBlob: this.tempBlob, cardId: null });
        
        const div = document.createElement('div');
        div.className = 'segment-bubble';
        div.innerHTML = `
            <div class="segment-target">${target}</div>
            <div class="segment-native">${native}</div>
            ${this.tempBlob ? '<span class="segment-audio-icon">🔊</span>' : ''}
        `;
        const container = document.getElementById('builder-stream');
        if (this.segments.length === 1) container.innerHTML = '';
        container.appendChild(div);
        container.scrollTop = container.scrollHeight;

        // Reset
        document.getElementById('dock-target').value = '';
        document.getElementById('dock-native').value = '';
        document.getElementById('dock-meta').value = '';
        document.getElementById('btn-record').textContent = '🎤';
        document.getElementById('dock-file').value = '';
        document.getElementById('file-status').classList.add('hidden');
        this.tempBlob = null;
    },

    async save() {
        const title = document.getElementById('builder-title').value || "Untitled";
        const tag = document.getElementById('builder-tag').value;
        await db.chapters.add({ title, tag, segments: this.segments });
        alert("Chapter Saved!");
        UI.toggleOverlay('overlay-builder', false);
        Library.refresh();
    }
};

// ==========================================
// 8. MODULE: READER VIEW (Heatmap)
// ==========================================
const Reader = {
    currentChapter: null,
    showMeta: true,
    showNative: true,

    async open(chapterId) {
        this.currentChapter = await db.chapters.get(chapterId);
        UI.toggleOverlay('overlay-reader', true);
        document.getElementById('reader-title').textContent = this.currentChapter.title;
        this.renderText();
    },

    toggleMeta() { 
        this.showMeta = !this.showMeta; 
        document.getElementById('btn-toggle-meta').classList.toggle('active', this.showMeta);
        this.renderText(); 
    },
    
    toggleNative() { 
        this.showNative = !this.showNative;
        document.getElementById('btn-toggle-native').classList.toggle('active', this.showNative); 
        this.renderText(); 
    },

    async renderText() {
        const container = document.getElementById('reader-content');
        container.innerHTML = '';
        
        // Heatmap logic: Check if segments have cardId or if text matches an existing card
        // Optimization: In real app, fetch all cards first. Here we assume segments store cardId
        
        this.currentChapter.segments.forEach((seg, index) => {
            const span = document.createElement('span');
            span.className = 'reader-segment';
            
            // Color Logic
            if (seg.cardId) span.classList.add('known');
            else span.classList.add('unknown');
            
            // Text Logic
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
        for (const seg of this.currentChapter.segments) {
            // Highlight current
            await AudioService.play(seg.audioBlob || seg.target);
            // Simple delay hack to wait for TTS finish would go here
            await new Promise(r => setTimeout(r, 2000)); 
        }
    },

    openSheet(seg, index) {
        const sheet = document.getElementById('reader-sheet');
        sheet.classList.remove('hidden');
        document.getElementById('sheet-target').textContent = seg.target;
        document.getElementById('sheet-native').textContent = seg.native;
        
        document.getElementById('btn-sheet-play').onclick = () => AudioService.play(seg.audioBlob || seg.target);

        const btnPromote = document.getElementById('btn-sheet-promote');
        if (seg.cardId) {
            btnPromote.textContent = "✓ Already in Deck";
            btnPromote.disabled = true;
        } else {
            btnPromote.textContent = "Promote to Card";
            btnPromote.disabled = false;
            btnPromote.onclick = () => this.promote(seg, index);
        }
    },

    async promote(seg, index) {
        const cardId = await db.cards.add({
            type: 'SENTENCE',
            target: seg.target,
            native: seg.native,
            meta: seg.meta,
            tag: this.currentChapter.tag,
            status: 'NEW',
            dueDate: null,
            interval: 0,
            lapses: 0
        });

        if (seg.audioBlob) await AudioService.saveAudio(seg.audioBlob, cardId);

        this.currentChapter.segments[index].cardId = cardId;
        await db.chapters.put(this.currentChapter);
        
        alert("Promoted!");
        this.renderText(); // Update color
        document.getElementById('reader-sheet').classList.add('hidden');
    }
};

// ==========================================
// 9. MODULE: DECK & IMPORT
// ==========================================
const Deck = {
    async refresh() {
        const list = await db.cards.limit(50).toArray(); 
        const container = document.getElementById('card-list');
        container.innerHTML = list.map(c => `
            <div class="card-item">
                <div>
                    <span class="item-main">${c.target}</span><br>
                    <span class="item-sub">${c.native}</span>
                </div>
                <div>
                    <button class="small-btn" onclick="Deck.delete(${c.id})">🗑</button>
                </div>
            </div>
        `).join('');
    },
    async delete(id) {
        if(confirm("Delete card?")) {
            await db.cards.delete(id);
            this.refresh();
            Dashboard.refresh();
        }
    },
    async runBulkImport() {
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

            let target = parts[0];
            let meta = parts.length > 2 ? parts[1] : "";
            let native = parts.length > 2 ? parts[2] : parts[1];

            // Type Detection
            let type = 'VOCAB';
            if (Logic.isCJK(target)) {
                if (/[。？！，,?!]/.test(target)) type = 'SENTENCE';
            } else {
                if (target.split(' ').length > 3) type = 'SENTENCE';
            }

            await db.cards.add({
                type, target, meta, native, tag,
                status: 'NEW', dueDate: null, interval: 0, lapses: 0
            });
            count++;
        }
        
        alert(`Imported ${count} cards!`);
        document.getElementById('modal-import').classList.add('hidden');
        Dashboard.refresh();
    }
};

// ==========================================
// 10. LISTENER WIRING
// ==========================================
const Library = {
    async refresh() {
        const list = await db.chapters.toArray();
        document.getElementById('chapter-list').innerHTML = list.map(c => `
            <div class="chapter-item" onclick="Reader.open(${c.id})">
                <span class="item-main">${c.title}</span>
                <span class="item-sub">${c.segments.length} segs</span>
            </div>
        `).join('');
    }
};

document.addEventListener('DOMContentLoaded', () => {
    Logic.userCredits = parseInt(localStorage.getItem('fd6_credits')) || 100;
    UI.updateCredits();
    Dashboard.refresh();

    // Nav
    document.querySelectorAll('.nav-item').forEach(btn => {
        btn.onclick = () => UI.showTab(btn.dataset.target);
    });

    // Overlays
    document.getElementById('btn-new-chapter').onclick = () => { StreamBuilder.init(); UI.toggleOverlay('overlay-builder', true); };
    document.getElementById('btn-quit-builder').onclick = () => UI.toggleOverlay('overlay-builder', false);
    document.getElementById('btn-quit-study').onclick = () => { UI.toggleOverlay('overlay-study', false); Dashboard.refresh(); };
    document.getElementById('btn-quit-reader').onclick = () => UI.toggleOverlay('overlay-reader', false);
    document.getElementById('btn-add-card').onclick = () => document.getElementById('modal-add-card').classList.remove('hidden');
    document.getElementById('btn-qa-cancel').onclick = () => document.getElementById('modal-add-card').classList.add('hidden');

    // Stream Builder
    document.getElementById('btn-record').onclick = () => StreamBuilder.toggleRecord();
    document.getElementById('dock-file').onchange = () => StreamBuilder.handleFileSelect();
    document.getElementById('btn-add-segment').onclick = () => StreamBuilder.addSegment();
    document.getElementById('btn-save-chapter').onclick = () => StreamBuilder.save();

    // Reader
    document.getElementById('btn-toggle-meta').onclick = () => Reader.toggleMeta();
    document.getElementById('btn-toggle-native').onclick = () => Reader.toggleNative();

    // Import
    document.getElementById('btn-open-import').onclick = () => document.getElementById('modal-import').classList.remove('hidden');
    document.getElementById('btn-cancel-import').onclick = () => document.getElementById('modal-import').classList.add('hidden');
    document.getElementById('btn-run-import').onclick = () => Deck.runBulkImport();

    // Quick Add
    document.getElementById('form-quick-add').onsubmit = async (e) => {
        e.preventDefault();
        // Handle Audio
        const fileInput = document.getElementById('qa-file');
        let blob = null;
        if(fileInput.files.length) blob = fileInput.files[0];

        const cardId = await db.cards.add({
            target: document.getElementById('qa-target').value,
            native: document.getElementById('qa-native').value,
            meta: document.getElementById('qa-meta').value,
            tag: document.getElementById('qa-tag').value,
            type: 'VOCAB', status: 'NEW', dueDate: null
        });
        
        if(blob) await AudioService.saveAudio(blob, cardId);
        
        document.getElementById('modal-add-card').classList.add('hidden');
        alert("Saved to New Queue");
        Dashboard.refresh();
    };

    // Cram
    document.getElementById('btn-start-cram').onclick = () => {
        if(Logic.userCredits < 50) return alert("Need 50 ⚡");
        Logic.addCredits(-50);
        document.getElementById('modal-cram-settings').classList.add('hidden');
        // Logic needed for filtering pool
        StudySession.queue = []; // Placeholder for cram logic
        alert("Cram Mode Unlocked (Logic placeholder)");
    };

    // Rating
    document.querySelectorAll('.rate-btn').forEach(btn => {
        btn.onclick = () => StudySession.rate(parseInt(btn.dataset.rating));
    });

    // Reset
    document.getElementById('btn-clear-db').onclick = async () => {
        if(confirm("Destroy Database?")) { await Dexie.delete('FlashDeckDB_v6'); location.reload(); }
    };
});

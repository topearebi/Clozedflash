/**
 * CLOZEFLASH - COMPLETE LOGIC
 * Features: Local-First DB, Import, Stream Builder, SM-2 Study, Arcade Test
 */

const DB_NAME = 'ClozeflashDB';
const DB_VERSION = 1;
let db;

// 1. DATABASE INIT
function initDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = (event) => {
            db = event.target.result;
            if (!db.objectStoreNames.contains('cards')) {
                const cardStore = db.createObjectStore('cards', { keyPath: 'id' });
                cardStore.createIndex('target_text', 'target_text', { unique: false }); 
                cardStore.createIndex('next_review', 'review_data.next_review_date', { unique: false });
            }
            if (!db.objectStoreNames.contains('collections')) {
                db.createObjectStore('collections', { keyPath: 'id' });
            }
            if (!db.objectStoreNames.contains('storyblocks')) {
                db.createObjectStore('storyblocks', { keyPath: 'id' });
            }
        };
        request.onsuccess = (event) => {
            db = event.target.result;
            console.log("DB Initialised");
            updateDashboardStats();
            resolve(db);
        };
        request.onerror = (e) => reject(e);
    });
}

// 2. HELPERS
const generateId = (prefix) => `${prefix}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

[cite_start]// SM-2 Algorithm [cite: 256]
function calculateSM2(quality, prevInterval, prevReps, prevEase) {
    let interval, reps, ease;
    if (quality >= 3) {
        if (prevReps === 0) interval = 1;
        else if (prevReps === 1) interval = 6;
        else interval = Math.round(prevInterval * prevEase);
        reps = prevReps + 1;
    } else {
        reps = 0;
        interval = 1;
    }
    ease = prevEase + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02));
    if (ease < 1.3) ease = 1.3;
    return { interval, reps, easeFactor: ease };
}

[cite_start]// Duplicate Rule Logic [cite: 164-172]
async function addCardToDB(target, native, meta, description, addToStudyQueue = true) {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(['cards'], 'readwrite');
        const store = transaction.objectStore('cards');
        const index = store.index('target_text');
        const cleanTarget = target.trim();

        const request = index.get(cleanTarget);
        request.onsuccess = () => {
            if (request.result) {
                resolve(request.result.id); // Return existing ID
            } else {
                const newCard = {
                    id: generateId('c'),
                    target_text: cleanTarget,
                    native_text: native,
                    meta_info: meta,
                    description: description,
                    audio_path: null,
                    status_flags: { is_mastered: false, is_study_queue: addToStudyQueue, consecutive_correct: 0 },
                    review_data: { next_review_date: new Date().toISOString().split('T')[0], interval: 0, ease_factor: 2.5 }
                };
                store.add(newCard);
                resolve(newCard.id);
            }
        };
    });
}

// 3. UI & NAV
function switchView(targetId) {
    document.querySelectorAll('.view').forEach(el => { el.classList.remove('active'); el.classList.add('hidden'); });
    document.querySelectorAll('.nav-links a').forEach(el => el.classList.remove('active'));
    document.getElementById(targetId).classList.remove('hidden');
    document.getElementById(targetId).classList.add('active');
    const navLink = document.querySelector(`a[data-target="${targetId}"]`);
    if(navLink) navLink.classList.add('active');
}

async function updateDashboardStats() {
    const tx = db.transaction(['cards'], 'readonly');
    const store = tx.objectStore('cards');
    store.getAll().onsuccess = (e) => {
        const cards = e.target.result;
        const today = new Date().toISOString().split('T')[0];
        document.getElementById('stat-total-cards').textContent = cards.length;
        document.getElementById('stat-due-cards').textContent = cards.filter(c => c.status_flags.is_study_queue && c.review_data.next_review_date <= today).length;
        document.getElementById('stat-mastered').textContent = cards.filter(c => c.status_flags.is_mastered).length;
    };
}

[cite_start]// 4. IMPORT LOGIC [cite: 221]
async function processTSV(content, filename) {
    const lines = content.split('\n');
    const totalLines = lines.length;
    const cardIds = [];
    const progressBar = document.getElementById('progress-fill');
    const progressText = document.getElementById('progress-text');
    let processedCount = 0;

    for (const line of lines) {
        if (!line.trim()) continue;
        const parts = line.split('\t');
        const target = parts[0] ? parts[0].trim() : "";
        if (target) {
            const cardId = await addCardToDB(
                target, 
                parts[2] ? parts[2].trim() : "", 
                parts[1] ? parts[1].trim() : "", 
                parts[3] ? parts[3].trim() : ""
            );
            cardIds.push(cardId);
        }
        processedCount++;
        if (processedCount % 10 === 0) {
            progressBar.style.width = `${Math.floor((processedCount / totalLines) * 100)}%`;
            progressText.textContent = `Processed ${processedCount} of ${totalLines}`;
            await new Promise(r => setTimeout(r, 0));
        }
    }

    if (cardIds.length > 0) {
        const name = prompt("Import complete! Name this collection:", filename.split('.')[0]);
        if (name) {
            const tx = db.transaction(['collections'], 'readwrite');
            tx.objectStore('collections').add({
                id: generateId('col'), name: name, card_refs: cardIds, created_at: new Date().toISOString()
            });
            alert("Success!");
            location.reload();
        }
    }
}

[cite_start]// 5. STREAM BUILDER LOGIC [cite: 230]
let activeStoryId = null;

async function createNewStory() {
    const title = prompt("Enter Story Title:");
    if (!title) return;
    const newStory = { id: generateId('sb'), title: title, segments: [] };
    const tx = db.transaction(['storyblocks'], 'readwrite');
    tx.objectStore('storyblocks').add(newStory);
    tx.oncomplete = () => loadStoryIntoStream(newStory.id);
}

async function loadStoryIntoStream(storyId) {
    activeStoryId = storyId;
    document.getElementById('story-list-view').classList.add('hidden');
    document.getElementById('stream-builder-view').classList.remove('hidden');
    
    const tx = db.transaction(['storyblocks', 'cards'], 'readonly');
    const storyStore = tx.objectStore('storyblocks');
    const cardStore = tx.objectStore('cards');

    storyStore.get(storyId).onsuccess = async (e) => {
        const story = e.target.result;
        document.getElementById('active-story-title').textContent = story.title;
        const container = document.getElementById('stream-history');
        container.innerHTML = '';
        for (const segment of story.segments) {
            const cardReq = cardStore.get(segment.card_id);
            await new Promise(r => {
                cardReq.onsuccess = () => { if(cardReq.result) renderBubble(cardReq.result); r(); };
            });
        }
        container.scrollTop = container.scrollHeight;
    };
}

async function handleDockSubmit() {
    const targetInput = document.getElementById('dock-target');
    const metaInput = document.getElementById('dock-meta');
    const nativeInput = document.getElementById('dock-native');
    const target = targetInput.value.trim();
    if (!target) return;

    [cite_start]// Default is_study_queue: false for stories [cite: 238]
    const cardId = await addCardToDB(target, nativeInput.value.trim(), metaInput.value.trim(), "Stream", false);

    const tx = db.transaction(['storyblocks'], 'readwrite');
    const store = tx.objectStore('storyblocks');
    store.get(activeStoryId).onsuccess = (e) => {
        const story = e.target.result;
        story.segments.push({ order: story.segments.length + 1, card_id: cardId });
        store.put(story);
        
        const cardTx = db.transaction(['cards'], 'readonly');
        cardTx.objectStore('cards').get(cardId).onsuccess = (ev) => {
            renderBubble(ev.target.result);
            targetInput.value = ''; metaInput.value = ''; nativeInput.value = ''; targetInput.focus();
            const c = document.getElementById('stream-history'); c.scrollTop = c.scrollHeight;
        };
    };
}

function renderBubble(card) {
    const container = document.getElementById('stream-history');
    const div = document.createElement('div');
    let statusClass = card.status_flags.is_study_queue ? 'status-study' : 'status-story-only';
    div.className = `bubble ${statusClass}`;
    const promoteBtn = !card.status_flags.is_study_queue ? `<button class="btn-text btn-small" onclick="promoteCard('${card.id}', this)">+ Promote to Flashcard</button>` : `<span style="font-size:0.8rem; color:var(--primary-color)">✓ In Deck</span>`;
    div.innerHTML = `<div class="bubble-meta">${card.meta_info||''}</div><div class="bubble-target">${card.target_text}</div><div class="bubble-native">${card.native_text||''}</div><div class="bubble-actions">${promoteBtn}</div>`;
    container.appendChild(div);
}

window.promoteCard = function(cardId, btn) {
    const tx = db.transaction(['cards'], 'readwrite');
    tx.objectStore('cards').get(cardId).onsuccess = (e) => {
        const card = e.target.result;
        card.status_flags.is_study_queue = true;
        tx.objectStore('cards').put(card);
        btn.closest('.bubble').classList.add('status-study');
        btn.outerHTML = `<span style="font-size:0.8rem; color:var(--primary-color)">✓ Promoted!</span>`;
    };
};

function renderStoryList() {
    const list = document.getElementById('story-list');
    list.innerHTML = '';
    const tx = db.transaction(['storyblocks'], 'readonly');
    tx.objectStore('storyblocks').getAll().onsuccess = (e) => {
        if(e.target.result.length === 0) { list.innerHTML = '<p class="empty-state">No stories.</p>'; return; }
        e.target.result.forEach(story => {
            const div = document.createElement('div');
            div.className = 'stat-card'; div.style.cursor = 'pointer';
            div.innerHTML = `<h3>${story.title}</h3><p style="font-size:1rem;">${story.segments.length} segments</p>`;
            div.addEventListener('click', () => loadStoryIntoStream(story.id));
            list.appendChild(div);
        });
    };
}

[cite_start]// 6. STUDY LOGIC [cite: 256]
let studyQueue = [];
let currentCard = null;

function prepareSession() {
    switchView('study-section');
    document.getElementById('btn-start-session').disabled = true;
    const today = new Date().toISOString().split('T')[0];
    const tx = db.transaction(['cards'], 'readonly');
    tx.objectStore('cards').index('next_review').getAll(IDBKeyRange.upperBound(today)).onsuccess = (e) => {
        studyQueue = e.target.result.filter(c => c.status_flags.is_study_queue);
        document.getElementById('study-count-display').textContent = studyQueue.length > 0 ? `Cards due: ${studyQueue.length}` : "No cards due!";
        if(studyQueue.length > 0) document.getElementById('btn-start-session').disabled = false;
    };
}

function startSessionUI() {
    document.getElementById('study-setup').classList.add('hidden');
    document.getElementById('study-active').classList.remove('hidden');
    loadNextCard();
}

function loadNextCard() {
    if(studyQueue.length === 0) { alert("Session Complete!"); switchView('dashboard-section'); updateDashboardStats(); return; }
    currentCard = studyQueue[0];
    document.getElementById('queue-counter').textContent = studyQueue.length;
    document.getElementById('card-target').textContent = currentCard.target_text;
    document.getElementById('card-back').classList.add('hidden');
    document.getElementById('btn-show-answer').classList.remove('hidden');
    document.getElementById('grading-buttons').classList.add('hidden');
    document.getElementById('card-native').textContent = currentCard.native_text;
    document.getElementById('card-meta').textContent = currentCard.meta_info;
    document.getElementById('card-desc').textContent = currentCard.description;
}

document.getElementById('btn-show-answer').addEventListener('click', () => {
    document.getElementById('card-back').classList.remove('hidden');
    document.getElementById('btn-show-answer').classList.add('hidden');
    document.getElementById('grading-buttons').classList.remove('hidden');
    playAudio(currentCard);
});

function playAudio(card) {
    const ind = document.getElementById('audio-status'); ind.classList.add('playing');
    if ('speechSynthesis' in window) {
        const u = new SpeechSynthesisUtterance(card.target_text);
        u.onend = () => ind.classList.remove('playing');
        speechSynthesis.speak(u);
    }
}

window.handleGrade = function(quality) {
    if (quality < 3) {
        studyQueue.push(currentCard); studyQueue.shift();
        currentCard.review_data.interval = 0;
        loadNextCard(); return;
    }
    studyQueue.shift();
    const res = calculateSM2(quality, currentCard.review_data.interval, currentCard.review_data.interval === 0 ? 0 : 1, currentCard.review_data.ease_factor);
    currentCard.review_data.interval = res.interval;
    currentCard.review_data.ease_factor = res.easeFactor;
    const next = new Date(); next.setDate(next.getDate() + res.interval);
    currentCard.review_data.next_review_date = next.toISOString().split('T')[0];
    if(quality >= 3) currentCard.status_flags.consecutive_correct++;
    if(currentCard.status_flags.consecutive_correct >= 5) currentCard.status_flags.is_mastered = true;
    
    const tx = db.transaction(['cards'], 'readwrite');
    tx.objectStore('cards').put(currentCard);
    loadNextCard();
};

[cite_start]// 7. TEST LOGIC [cite: 257]
let testQueue = [], testScore = 0, testRound = 1, testTimer = null, currentTestCard = null, isStickyMode = false;

function prepareTestSession() {
    switchView('test-section');
    const tx = db.transaction(['cards'], 'readonly');
    tx.objectStore('cards').getAll().onsuccess = (e) => {
        const all = e.target.result.filter(c => c.status_flags.is_study_queue);
        if(all.length < 5) { alert("Need at least 5 cards!"); switchView('dashboard-section'); return; }
        [cite_start]// Fisher-Yates Shuffle [cite: 259]
        for (let i = all.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [all[i], all[j]] = [all[j], all[i]]; }
        testQueue = all; testScore = 0; testRound = 1;
        document.getElementById('test-score').textContent = 0;
    };
}

function startTestUI() {
    document.getElementById('test-setup').classList.add('hidden');
    document.getElementById('test-active').classList.remove('hidden');
    nextTestRound();
}

function nextTestRound() {
    if(testQueue.length === 0) { alert(`Game Over! Score: ${testScore}`); location.reload(); return; }
    isStickyMode = false;
    currentTestCard = testQueue.pop();
    document.getElementById('test-native').textContent = currentTestCard.native_text;
    document.getElementById('test-meta').textContent = currentTestCard.meta_info || '???';
    const input = document.getElementById('test-input'); input.value = ''; input.focus();
    document.getElementById('sticky-cloze-area').classList.add('hidden');
    
    [cite_start]// Decay Timer [cite: 258]
    const duration = 10000 * Math.pow(0.95, testRound);
    if(testTimer) clearInterval(testTimer);
    let rem = duration;
    const bar = document.getElementById('timer-bar');
    testTimer = setInterval(() => {
        rem -= 100; bar.style.width = `${(rem/duration)*100}%`;
        if(rem <= 0) { clearInterval(testTimer); triggerStickyCloze(); }
    }, 100);
}

document.getElementById('btn-submit-test').addEventListener('click', handleTestSubmit);
document.getElementById('test-input').addEventListener('keypress', (e) => { if(e.key === 'Enter') handleTestSubmit(); });

function handleTestSubmit() {
    const val = document.getElementById('test-input').value.trim();
    if(val.toLowerCase() === currentTestCard.target_text.trim().toLowerCase()) {
        if(!isStickyMode) { clearInterval(testTimer); testScore++; testRound++; document.getElementById('test-score').textContent = testScore; }
        nextTestRound();
    } else {
        if(!isStickyMode) { clearInterval(testTimer); triggerStickyCloze(); }
    }
}

function triggerStickyCloze() {
    isStickyMode = true;
    document.getElementById('sticky-cloze-area').classList.remove('hidden');
    document.getElementById('test-correct-answer').textContent = currentTestCard.target_text;
    const input = document.getElementById('test-input'); input.value = ''; input.placeholder = "Type exact answer..."; input.focus();
}

// INIT LISTENERS
document.addEventListener('DOMContentLoaded', () => {
    initDB();
    document.querySelectorAll('.nav-links a').forEach(link => link.addEventListener('click', (e) => { e.preventDefault(); switchView(e.target.getAttribute('data-target')); }));
    document.getElementById('btn-reset-db').addEventListener('click', () => { if(confirm("Wipe all data?")) indexedDB.deleteDatabase(DB_NAME).onsuccess = () => location.reload(); });
    document.getElementById('btn-new-collection').addEventListener('click', () => switchView('settings-section')); // Redirect to import
    document.getElementById('tsv-file-input').addEventListener('change', (e) => {
        const r = new FileReader();
        document.getElementById('progress-container').classList.remove('hidden');
        r.onload = (ev) => processTSV(ev.target.result, e.target.files[0].name);
        r.readAsText(e.target.files[0]);
    });
    document.getElementById('btn-create-story').addEventListener('click', createNewStory);
    document.getElementById('btn-dock-submit').addEventListener('click', handleDockSubmit);
    document.getElementById('btn-back-stories').addEventListener('click', () => { document.getElementById('stream-builder-view').classList.add('hidden'); document.getElementById('story-list-view').classList.remove('hidden'); renderStoryList(); });
    document.getElementById('toggle-meta').addEventListener('change', (e) => document.getElementById('stream-history').classList.toggle('hide-meta', !e.target.checked));
    document.getElementById('toggle-native').addEventListener('change', (e) => document.getElementById('stream-history').classList.toggle('hide-native', !e.target.checked));
    document.querySelector('a[data-target="read-section"]').addEventListener('click', renderStoryList);
    document.getElementById('btn-learn-all').addEventListener('click', prepareSession);
    document.getElementById('btn-start-session').addEventListener('click', startSessionUI);
    document.getElementById('btn-test-all').addEventListener('click', prepareTestSession);
    document.getElementById('btn-start-test').addEventListener('click', startTestUI);
});

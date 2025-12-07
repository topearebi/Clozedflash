/**
 * CLOZEFLASH - Local-First Language Learning Application
 * Architecture: Single Page Application (SPA) using IndexedDB.
 * Features: Relational Schema, SM-2 Spaced Repetition, Arcade Timer, Stream Builder.
 */

/* =========================================
   1. GLOBAL CONSTANTS & STATE
   ========================================= */
const DB_NAME = 'ClozeflashDB';
const DB_VERSION = 1;

// Global Database Reference
let db;

// Module State: Stories
let activeStoryId = null;

// Module State: Study Session
let studyQueue = [];
let currentCard = null;

// Module State: Arcade Test Session
let testQueue = [];
let testScore = 0;
let testRound = 1;
let testTimer = null;
let currentTestCard = null;
let isStickyMode = false;

/* =========================================
   2. DATABASE INITIALISATION
   ========================================= */

function initDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = (event) => {
            db = event.target.result;

            // Store 1: Cards (Single Source of Truth)
            if (!db.objectStoreNames.contains('cards')) {
                const cardStore = db.createObjectStore('cards', { keyPath: 'id' });
                // Index for duplicate checking
                cardStore.createIndex('target_text', 'target_text', { unique: false }); 
                // Index for study queries
                cardStore.createIndex('next_review', 'review_data.next_review_date', { unique: false });
            }

            // Store 2: Collections (Reference Lists)
            if (!db.objectStoreNames.contains('collections')) {
                db.createObjectStore('collections', { keyPath: 'id' });
            }

            // Store 3: Storyblocks (Narrative Content)
            if (!db.objectStoreNames.contains('storyblocks')) {
                db.createObjectStore('storyblocks', { keyPath: 'id' });
            }
        };

        request.onsuccess = (event) => {
            db = event.target.result;
            console.log("Database initialised successfully.");
            updateDashboardStats(); 
            resolve(db);
        };

        request.onerror = (event) => {
            console.error("Database error:", event.target.error);
            reject(event.target.error);
        };
    });
}

/* =========================================
   3. HELPER FUNCTIONS
   ========================================= */

// Unique ID Generator
const generateId = (prefix) => `${prefix}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

// View Switcher (SPA Routing)
function switchView(targetId) {
    // Hide all views
    document.querySelectorAll('.view').forEach(el => {
        el.classList.remove('active');
        el.classList.add('hidden');
    });
    
    // Update Navigation State
    document.querySelectorAll('.nav-links a').forEach(el => el.classList.remove('active'));
    const navLink = document.querySelector(`a[data-target="${targetId}"]`);
    if(navLink) navLink.classList.add('active');

    // Show Target View
    const targetEl = document.getElementById(targetId);
    if (targetEl) {
        targetEl.classList.remove('hidden');
        targetEl.classList.add('active');
    }
}

// Fisher-Yates Shuffle Algorithm
function fisherYatesShuffle(array) {
    let currentIndex = array.length, randomIndex;
    while (currentIndex != 0) {
        randomIndex = Math.floor(Math.random() * currentIndex);
        currentIndex--;
        [array[currentIndex], array[randomIndex]] = [array[randomIndex], array[currentIndex]];
    }
    return array;
}

// SM-2 Spaced Repetition Algorithm
function calculateSM2(quality, previousInterval, previousRepetitions, previousEaseFactor) {
    let interval, repetitions, easeFactor;

    if (quality >= 3) {
        if (previousRepetitions === 0) {
            interval = 1;
        } else if (previousRepetitions === 1) {
            interval = 6;
        } else {
            interval = Math.round(previousInterval * previousEaseFactor);
        }
        repetitions = previousRepetitions + 1;
    } else {
        repetitions = 0;
        interval = 1;
    }

    easeFactor = previousEaseFactor + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02));
    if (easeFactor < 1.3) easeFactor = 1.3;

    return { interval, repetitions, easeFactor };
}

/* =========================================
   4. CORE DB LOGIC (ADD CARD)
   ========================================= */

/**
 * Adds a card or returns existing ID (Duplicate Rule).
 * @param {string} target - Target language text
 * @param {string} native - Native translation
 * @param {string} meta - Pinyin/Romaji etc
 * @param {string} description - Notes
 * @param {boolean} addToStudyQueue - TRUE for imports/manual, FALSE for stream builder
 */
function addCardToDB(target, native, meta, description, addToStudyQueue = true) {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(['cards'], 'readwrite');
        const store = transaction.objectStore('cards');
        const index = store.index('target_text');
        
        const cleanTarget = target.trim(); // IndexedDB indexing is case-sensitive by default

        // Duplicate Check
        const request = index.get(cleanTarget);

        request.onsuccess = () => {
            if (request.result) {
                // Match Found: Return existing ID. Do NOT overwrite data.
                // We do not enable study queue here automatically to preserve user intent.
                resolve(request.result.id);
            } else {
                // No Match: Create New Card
                const newCard = {
                    id: generateId('c'),
                    target_text: cleanTarget,
                    native_text: native,
                    meta_info: meta,
                    description: description,
                    audio_path: null,
                    status_flags: {
                        is_mastered: false,
                        is_study_queue: addToStudyQueue, 
                        consecutive_correct: 0
                    },
                    review_data: {
                        next_review_date: new Date().toISOString().split('T')[0], // Due Today
                        interval: 0,
                        ease_factor: 2.5
                    }
                };
                store.add(newCard);
                resolve(newCard.id);
            }
        };
        request.onerror = (e) => reject(e);
    });
}

/* =========================================
   5. DASHBOARD MODULE
   ========================================= */

function updateDashboardStats() {
    if (!db) return;
    const tx = db.transaction(['cards'], 'readonly');
    const store = tx.objectStore('cards');
    const request = store.getAll();

    request.onsuccess = () => {
        const cards = request.result;
        const total = cards.length;
        const today = new Date().toISOString().split('T')[0];
        
        // Logic: Due cards must be in study queue AND due date <= today
        const due = cards.filter(c => 
            c.status_flags.is_study_queue && 
            c.review_data.next_review_date <= today
        ).length;

        const mastered = cards.filter(c => c.status_flags.is_mastered).length;

        // Safely update DOM
        const elTotal = document.getElementById('stat-total-cards');
        const elDue = document.getElementById('stat-due-cards');
        const elMastered = document.getElementById('stat-mastered');
        
        if (elTotal) elTotal.textContent = total;
        if (elDue) elDue.textContent = due;
        if (elMastered) elMastered.textContent = mastered;
    };
}

/* =========================================
   6. COLLECTIONS MODULE
   ========================================= */

function renderCollectionList() {
    const container = document.getElementById('collection-list');
    const emptyMsg = document.getElementById('no-collections-msg');
    
    // Clear current list
    container.innerHTML = '';

    const tx = db.transaction(['collections'], 'readonly');
    const store = tx.objectStore('collections');
    const request = store.getAll();

    request.onsuccess = () => {
        const collections = request.result;

        if (collections.length === 0) {
            emptyMsg.classList.remove('hidden');
            return;
        }

        emptyMsg.classList.add('hidden');

        collections.forEach(col => {
            const card = document.createElement('div');
            card.className = 'stat-card';
            card.style.textAlign = 'left'; 
            
            const cardCount = col.card_refs ? col.card_refs.length : 0;

            card.innerHTML = `
                <h3 style="color:var(--primary-color); font-size:1.1rem; margin-bottom:0.5rem;">${col.name}</h3>
                <p style="font-size:0.9rem; color:var(--text-main); font-weight:normal;">${cardCount} Cards</p>
                <div style="margin-top:1rem; display:flex; gap:0.5rem; flex-wrap:wrap;">
                    <button class="btn btn-small btn-primary" onclick="studyCollection('${col.id}')">Learn</button>
                    <button class="btn btn-small btn-danger" onclick="deleteCollection('${col.id}')">Delete</button>
                </div>
            `;
            container.appendChild(card);
        });
    };
}

// Action: Learn specific collection
window.studyCollection = function(colId) {
    const tx = db.transaction(['collections'], 'readonly');
    const store = tx.objectStore('collections');
    const req = store.get(colId);

    req.onsuccess = () => {
        const col = req.result;
        if(col && col.card_refs.length > 0) {
            // Filter global cards by this collection's reference list
            const cardTx = db.transaction(['cards'], 'readonly');
            cardTx.objectStore('cards').getAll().onsuccess = (e) => {
                const allCards = e.target.result;
                const today = new Date().toISOString().split('T')[0];

                // Filter logic: In Collection AND In Study Queue AND Due Today (or past)
                studyQueue = allCards.filter(c => 
                    col.card_refs.includes(c.id) && 
                    c.status_flags.is_study_queue &&
                    c.review_data.next_review_date <= today
                );
                
                if(studyQueue.length > 0) {
                    switchView('study-section');
                    startSessionUI(); // Start immediately
                } else {
                    alert("No cards due in this collection right now!");
                }
            };
        } else {
            alert("This collection is empty.");
        }
    };
};

// Action: Delete Collection
window.deleteCollection = function(colId) {
    if(confirm("Delete this collection? (Cards will remain in database, but the list will be gone)")) {
        const tx = db.transaction(['collections'], 'readwrite');
        tx.objectStore('collections').delete(colId);
        tx.oncomplete = () => {
            renderCollectionList(); 
            updateDashboardStats();
        };
    }
};

/* =========================================
   7. IMPORT MODULE (TSV)
   ========================================= */

async function handleFileSelect(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    const progressContainer = document.getElementById('progress-container');
    const progressText = document.getElementById('progress-text');

    progressContainer.classList.remove('hidden');
    progressText.textContent = "Reading file...";

    reader.onload = async (e) => {
        const content = e.target.result;
        await processTSV(content, file.name);
    };
    reader.readAsText(file);
}

async function processTSV(content, filename) {
    const lines = content.split('\n');
    const totalLines = lines.length;
    const cardIds = []; 
    const progressBar = document.getElementById('progress-fill');
    const progressText = document.getElementById('progress-text');

    let processedCount = 0;

    for (const line of lines) {
        if (!line.trim()) continue;

        // Strict TSV Parsing
        const parts = line.split('\t');
        
        // Column Order: Target | Meta | Native | Description
        const target = parts[0] ? parts[0].trim() : "";
        const meta = parts[1] ? parts[1].trim() : "";
        const native = parts[2] ? parts[2].trim() : "";
        const description = parts[3] ? parts[3].trim() : "";

        if (target) {
            // Duplicate Rule applied here via addCardToDB
            // addToStudyQueue is TRUE for imports
            const cardId = await addCardToDB(target, native, meta, description, true);
            cardIds.push(cardId);
        }

        processedCount++;
        
        // Update UI every 10 items to prevent freezing
        if (processedCount % 10 === 0) {
            const percentage = Math.floor((processedCount / totalLines) * 100);
            progressBar.style.width = `${percentage}%`;
            progressText.textContent = `Processed ${processedCount} of ${totalLines}`;
            await new Promise(r => setTimeout(r, 0)); 
        }
    }

    if (cardIds.length > 0) {
        const collectionName = prompt("Import complete! Name this collection:", filename.split('.')[0]);
        if (collectionName) {
            // Create Collection Reference
            const tx = db.transaction(['collections'], 'readwrite');
            tx.objectStore('collections').add({
                id: generateId('col'),
                name: collectionName,
                card_refs: cardIds,
                created_at: new Date().toISOString()
            });
            alert("Import Successful!");
            location.reload(); 
        }
    } else {
        alert("No valid cards found.");
    }
    
    // Reset UI
    document.getElementById('progress-container').classList.add('hidden');
    document.getElementById('tsv-file-input').value = ""; 
}

/* =========================================
   8. STREAM BUILDER MODULE
   ========================================= */

// Create New Story
async function createNewStory() {
    const title = prompt("Enter Story Title:");
    if (!title) return;

    const newStory = {
        id: generateId('sb'),
        title: title,
        collection_id: null,
        segments: [], 
        created_at: new Date().toISOString()
    };

    const tx = db.transaction(['storyblocks'], 'readwrite');
    tx.objectStore('storyblocks').add(newStory);
    
    tx.oncomplete = () => loadStoryIntoStream(newStory.id);
}

// Load Story
function loadStoryIntoStream(storyId) {
    activeStoryId = storyId;
    
    // UI Switch
    document.getElementById('story-list-view').classList.add('hidden');
    document.getElementById('stream-builder-view').classList.remove('hidden');
    
    const tx = db.transaction(['storyblocks', 'cards'], 'readonly');
    const storyStore = tx.objectStore('storyblocks');
    const cardStore = tx.objectStore('cards');

    const storyReq = storyStore.get(storyId);
    
    storyReq.onsuccess = async () => {
        const story = storyReq.result;
        document.getElementById('active-story-title').textContent = story.title;
        const container = document.getElementById('stream-history');
        container.innerHTML = ''; 

        // Render Segments
        for (const segment of story.segments) {
            const cardReq = cardStore.get(segment.card_id);
            await new Promise(r => {
                cardReq.onsuccess = () => {
                    if (cardReq.result) renderBubble(cardReq.result);
                    r();
                };
            });
        }
        container.scrollTop = container.scrollHeight;
    };
}

// Submit via Dock
async function handleDockSubmit() {
    const targetInput = document.getElementById('dock-target');
    const metaInput = document.getElementById('dock-meta');
    const nativeInput = document.getElementById('dock-native');
    const target = targetInput.value.trim();

    if (!target) return;

    // is_study_queue = FALSE for Stream Builder
    const cardId = await addCardToDB(
        target, 
        nativeInput.value.trim(), 
        metaInput.value.trim(), 
        "Created via Stream", 
        false 
    );

    // Update Storyblock with new Segment
    const tx = db.transaction(['storyblocks'], 'readwrite');
    const store = tx.objectStore('storyblocks');
    const req = store.get(activeStoryId);

    req.onsuccess = () => {
        const story = req.result;
        story.segments.push({
            order: story.segments.length + 1,
            card_id: cardId
        });
        store.put(story);

        // Render Bubble
        const cardTx = db.transaction(['cards'], 'readonly');
        cardTx.objectStore('cards').get(cardId).onsuccess = (e) => {
            renderBubble(e.target.result);
            targetInput.value = '';
            metaInput.value = '';
            nativeInput.value = '';
            targetInput.focus();
            
            const container = document.getElementById('stream-history');
            container.scrollTop = container.scrollHeight;
        };
    };
}

// Render Bubble
function renderBubble(card) {
    const container = document.getElementById('stream-history');
    const div = document.createElement('div');
    
    let statusClass = 'status-story-only'; 
    if (card.status_flags.is_study_queue) statusClass = 'status-study'; 
    if (card.status_flags.is_mastered) statusClass = 'status-mastered';

    div.className = `bubble ${statusClass}`;
    
    // Promote Button Logic
    const promoteBtn = !card.status_flags.is_study_queue 
        ? `<button class="btn-text btn-small" onclick="promoteCard('${card.id}', this)">+ Promote to Flashcard</button>` 
        : `<span style="font-size:0.8rem; color:var(--primary-color)">✓ In Deck</span>`;

    div.innerHTML = `
        <div class="bubble-meta">${card.meta_info || ''}</div>
        <div class="bubble-target">${card.target_text}</div>
        <div class="bubble-native">${card.native_text || ''}</div>
        <div class="bubble-actions">${promoteBtn}</div>
    `;
    container.appendChild(div);
}

// Global promote function for inline HTML access
window.promoteCard = function(cardId, btnElement) {
    const tx = db.transaction(['cards'], 'readwrite');
    const store = tx.objectStore('cards');
    const req = store.get(cardId);

    req.onsuccess = () => {
        const card = req.result;
        card.status_flags.is_study_queue = true; 
        store.put(card);

        // UI Feedback
        const bubble = btnElement.closest('.bubble');
        bubble.classList.add('status-study');
        bubble.classList.remove('status-story-only');
        btnElement.outerHTML = `<span style="font-size:0.8rem; color:var(--primary-color)">✓ Promoted!</span>`;
    };
};

function renderStoryList() {
    const list = document.getElementById('story-list');
    list.innerHTML = '';
    
    const tx = db.transaction(['storyblocks'], 'readonly');
    const store = tx.objectStore('storyblocks');
    const req = store.getAll();

    req.onsuccess = () => {
        if (req.result.length === 0) {
            list.innerHTML = '<p class="empty-state">No stories yet.</p>';
            return;
        }
        req.result.forEach(story => {
            const card = document.createElement('div');
            card.className = 'stat-card';
            card.style.textAlign = 'left';
            card.style.cursor = 'pointer';
            card.innerHTML = `<h3>${story.title}</h3><p>${story.segments.length} segments</p>`;
            card.addEventListener('click', () => loadStoryIntoStream(story.id));
            list.appendChild(card);
        });
    };
}

/* =========================================
   9. STUDY MODULE (SM-2)
   ========================================= */

// Prepare global session (all due cards)
function prepareSession() {
    switchView('study-section');
    const display = document.getElementById('study-count-display');
    const btn = document.getElementById('btn-start-session');
    
    display.textContent = "Loading cards...";
    btn.disabled = true;

    const today = new Date().toISOString().split('T')[0];
    const tx = db.transaction(['cards'], 'readonly');
    const store = tx.objectStore('cards');
    const index = store.index('next_review');

    // Get all cards due <= Today
    const range = IDBKeyRange.upperBound(today);
    const request = index.getAll(range);

    request.onsuccess = () => {
        // Filter: Must be in study queue
        const allDue = request.result;
        studyQueue = allDue.filter(c => c.status_flags.is_study_queue);

        if (studyQueue.length > 0) {
            display.textContent = `You have ${studyQueue.length} cards due for review today.`;
            btn.disabled = false;
        } else {
            display.textContent = "No cards due! Great job.";
        }
    };
}

function startSessionUI() {
    document.getElementById('study-setup').classList.add('hidden');
    document.getElementById('study-active').classList.remove('hidden');
    loadNextCard();
}

function loadNextCard() {
    if (studyQueue.length === 0) {
        alert("Session Complete!");
        switchView('dashboard-section');
        updateDashboardStats();
        return;
    }

    currentCard = studyQueue[0];
    document.getElementById('queue-counter').textContent = studyQueue.length;
    document.getElementById('card-target').textContent = currentCard.target_text;
    
    // Reset UI State
    document.getElementById('card-back').classList.add('hidden');
    document.getElementById('btn-show-answer').classList.remove('hidden');
    document.getElementById('grading-buttons').classList.add('hidden');
    
    // Fill Back Data
    document.getElementById('card-native').textContent = currentCard.native_text;
    document.getElementById('card-meta').textContent = currentCard.meta_info;
    document.getElementById('card-desc').textContent = currentCard.description;
}

function revealAnswer() {
    document.getElementById('card-back').classList.remove('hidden');
    document.getElementById('btn-show-answer').classList.add('hidden');
    document.getElementById('grading-buttons').classList.remove('hidden');
    playAudio(currentCard);
}

// Audio Prioritization: File -> TTS
function playAudio(card) {
    const indicator = document.getElementById('audio-status');
    indicator.classList.add('playing');

    if (card.audio_path) {
        const audio = new Audio(card.audio_path);
        audio.play();
        audio.onended = () => indicator.classList.remove('playing');
    } else {
        if ('speechSynthesis' in window) {
            const utterance = new SpeechSynthesisUtterance(card.target_text);
            speechSynthesis.speak(utterance);
            utterance.onend = () => indicator.classList.remove('playing');
        } else {
            indicator.textContent = "Audio not supported";
        }
    }
}

// Grading Logic (SM-2)
window.handleGrade = function(quality) {
    // 1. Re-queue logic (Fail)
    if (quality < 3) {
        studyQueue.push(currentCard);
        studyQueue.shift(); 
        currentCard.review_data.interval = 0; // Reset interval
        loadNextCard(); 
        return; 
    }

    // 2. SM-2 Success Logic
    studyQueue.shift();

    const prevData = currentCard.review_data;
    const result = calculateSM2(
        quality, 
        prevData.interval, 
        prevData.interval === 0 ? 0 : 1, 
        prevData.ease_factor
    );

    currentCard.review_data.interval = result.interval;
    currentCard.review_data.ease_factor = result.ease_factor;
    
    const nextDate = new Date();
    nextDate.setDate(nextDate.getDate() + result.interval);
    currentCard.review_data.next_review_date = nextDate.toISOString().split('T')[0];

    // Check Mastery
    currentCard.status_flags.consecutive_correct = 
        quality >= 3 ? currentCard.status_flags.consecutive_correct + 1 : 0;
    
    if (currentCard.status_flags.consecutive_correct >= 5) {
        currentCard.status_flags.is_mastered = true; 
    }

    // Update DB
    const tx = db.transaction(['cards'], 'readwrite');
    tx.objectStore('cards').put(currentCard);

    loadNextCard();
};

/* =========================================
   10. TEST MODULE (ARCADE)
   ========================================= */

const BASE_TIME_MS = 10000; 
const DECAY_FACTOR = 0.95;  

function prepareTestSession() {
    switchView('test-section');
    
    const tx = db.transaction(['cards'], 'readonly');
    const store = tx.objectStore('cards');
    const request = store.getAll();

    request.onsuccess = () => {
        // Filter: Must be in study queue (Have been seen/added)
        const allCards = request.result.filter(c => c.status_flags.is_study_queue);
        
        if (allCards.length < 5) {
            alert("Not enough cards to test! Go learn some cards first.");
            switchView('dashboard-section');
            return;
        }

        testQueue = fisherYatesShuffle(allCards);
        testScore = 0;
        testRound = 1;
        document.getElementById('test-score').textContent = 0;
    };
}

function startTestUI() {
    document.getElementById('test-setup').classList.add('hidden');
    document.getElementById('test-active').classList.remove('hidden');
    nextTestRound();
}

function nextTestRound() {
    if (testQueue.length === 0) {
        alert(`Game Over! Final Score: ${testScore}`);
        location.reload();
        return;
    }

    isStickyMode = false;
    currentTestCard = testQueue.pop();

    document.getElementById('test-native').textContent = currentTestCard.native_text;
    document.getElementById('test-meta').textContent = currentTestCard.meta_info || '???';
    
    const input = document.getElementById('test-input');
    input.value = '';
    input.disabled = false;
    input.placeholder = "Type the Target Language...";
    input.style.borderColor = '#e2e8f0'; 
    input.focus();
    
    document.getElementById('sticky-cloze-area').classList.add('hidden');

    // Decay Timer
    const duration = BASE_TIME_MS * Math.pow(DECAY_FACTOR, testRound);
    startTimer(duration);
}

function startTimer(durationMs) {
    if (testTimer) clearInterval(testTimer);
    
    const bar = document.getElementById('timer-bar');
    let remaining = durationMs;
    const interval = 100; 

    bar.style.width = '100%';

    testTimer = setInterval(() => {
        remaining -= interval;
        const pct = (remaining / durationMs) * 100;
        bar.style.width = `${pct}%`;

        if (remaining <= 0) {
            clearInterval(testTimer);
            triggerStickyCloze(); // Sticky Cloze on Timeout
        }
    }, interval);
}

function handleTestSubmit() {
    const input = document.getElementById('test-input');
    const userAns = input.value.trim();
    const correctAns = currentTestCard.target_text.trim();

    if (userAns.toLowerCase() === correctAns.toLowerCase()) {
        // Correct
        if (isStickyMode) {
            nextTestRound(); // Passed stickiness, no points
        } else {
            clearInterval(testTimer);
            testScore++;
            testRound++; 
            document.getElementById('test-score').textContent = testScore;
            
            input.style.borderColor = '#22c55e'; // Green
            setTimeout(() => {
                nextTestRound();
            }, 500);
        }
    } else {
        // Incorrect
        if (!isStickyMode) {
            clearInterval(testTimer);
            triggerStickyCloze();
        } else {
            input.classList.add('shake'); // Optional animation class
            setTimeout(() => input.classList.remove('shake'), 500);
        }
    }
}

function triggerStickyCloze() {
    isStickyMode = true;
    const input = document.getElementById('test-input');
    document.getElementById('sticky-cloze-area').classList.remove('hidden');
    document.getElementById('test-correct-answer').textContent = currentTestCard.target_text;
    
    input.value = ''; 
    input.placeholder = "Type the answer exactly to continue...";
    input.focus();
    input.style.borderColor = '#ef4444'; // Red
}

/* =========================================
   11. INITIALISATION & LISTENERS
   ========================================= */

document.addEventListener('DOMContentLoaded', () => {
    // 1. Init Database
    initDB();

    // 2. Navigation Routing
    document.querySelectorAll('.nav-links a').forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            const target = e.target.getAttribute('data-target');
            
            // Trigger Renders based on view selection
            if(target === 'read-section') renderStoryList();
            if(target === 'collections-section') renderCollectionList();
            
            switchView(target);
        });
    });

    // 3. Settings / Data Management Events
    const resetBtn = document.getElementById('btn-reset-db');
    if(resetBtn) {
        resetBtn.addEventListener('click', () => {
            if(confirm("Are you sure? This will wipe all data permanently.")) {
                const req = indexedDB.deleteDatabase(DB_NAME);
                req.onsuccess = () => location.reload();
            }
        });
    }

    const exportBtn = document.getElementById('btn-export-json');
    if(exportBtn) {
        exportBtn.addEventListener('click', () => {
            const tx = db.transaction(['cards', 'collections', 'storyblocks'], 'readonly');
            Promise.all([
                new Promise(resolve => tx.objectStore('cards').getAll().onsuccess = (e) => resolve(e.target.result)),
                new Promise(resolve => tx.objectStore('collections').getAll().onsuccess = (e) => resolve(e.target.result)),
                new Promise(resolve => tx.objectStore('storyblocks').getAll().onsuccess = (e) => resolve(e.target.result))
            ]).then(([cards, collections, stories]) => {
                const data = { cards, collections, stories };
                const blob = new Blob([JSON.stringify(data, null, 2)], {type : 'application/json'});
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `clozeflash_backup_${new Date().toISOString().split('T')[0]}.json`;
                a.click();
            });
        });
    }

    // 4. Import Events
    const tsvInput = document.getElementById('tsv-file-input');
    if(tsvInput) tsvInput.addEventListener('change', handleFileSelect);

    // 5. Story Events
    const btnCreateStory = document.getElementById('btn-create-story');
    if(btnCreateStory) btnCreateStory.addEventListener('click', createNewStory);

    const btnDockSubmit = document.getElementById('btn-dock-submit');
    if(btnDockSubmit) btnDockSubmit.addEventListener('click', handleDockSubmit);

    const btnBackStories = document.getElementById('btn-back-stories');
    if(btnBackStories) btnBackStories.addEventListener('click', () => {
        document.getElementById('stream-builder-view').classList.add('hidden');
        document.getElementById('story-list-view').classList.remove('hidden');
        renderStoryList();
    });

    document.getElementById('toggle-meta').addEventListener('change', (e) => {
        document.getElementById('stream-history').classList.toggle('hide-meta', !e.target.checked);
    });
    document.getElementById('toggle-native').addEventListener('change', (e) => {
        document.getElementById('stream-history').classList.toggle('hide-native', !e.target.checked);
    });

    // 6. Study Events
    document.getElementById('btn-learn-all').addEventListener('click', prepareSession);
    document.getElementById('btn-start-session').addEventListener('click', startSessionUI);
    document.getElementById('btn-show-answer').addEventListener('click', revealAnswer);

    // 7. Test Events
    document.getElementById('btn-test-all').addEventListener('click', prepareTestSession);
    document.getElementById('btn-start-test').addEventListener('click', startTestUI);
    document.getElementById('btn-submit-test').addEventListener('click', handleTestSubmit);
    
    const testInput = document.getElementById('test-input');
    if(testInput) {
        testInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') handleTestSubmit();
        });
    }
    
    // 8. Collection Manual Create
    const btnManualCol = document.getElementById('btn-manual-collection');
    if(btnManualCol) {
        btnManualCol.addEventListener('click', async () => {
            const name = prompt("Collection Name:");
            if(name) {
                const tx = db.transaction(['collections'], 'readwrite');
                tx.objectStore('collections').add({
                    id: generateId('col'),
                    name: name,
                    card_refs: [],
                    created_at: new Date().toISOString()
                });
                tx.oncomplete = () => renderCollectionList();
            }
        });
    }
});

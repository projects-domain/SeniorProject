document.addEventListener("DOMContentLoaded", () => {
    const bootScreen = document.getElementById('bootScreen');
    const minimumBootTime = new Promise(resolve => window.setTimeout(resolve, 650));
    const initialInventoryLoad = fetchTools(false);

    Promise.all([minimumBootTime, initialInventoryLoad]).then(() => {
        if (bootScreen) {
            bootScreen.classList.add('is-done');
            window.setTimeout(() => {
                bootScreen.remove();
                revealApplication();
            }, 260);
        } else {
            revealApplication();
        }
    });
    document.addEventListener('keydown', captureUsbScannerInput);
    document.getElementById('webNfcButton').hidden = !('NDEFReader' in window);
    document.getElementById('addToolForm').addEventListener('submit', event => {
        event.preventDefault();
        addTool();
    });
    document.getElementById('cancelAddButton').addEventListener('click', hideAddToolForm);
    document.getElementById('inventorySearch').addEventListener('input', renderInventory);
    document.getElementById('statusFilter').addEventListener('change', renderInventory);
    initializeStatusFilter();
    document.getElementById('scannedCheckInButton').addEventListener('click', () => {
        if (scannedTool) updateStatus(scannedTool.tag_id, 'Present');
    });
    document.getElementById('scannedCheckOutButton').addEventListener('click', () => {
        if (scannedTool) updateStatus(scannedTool.tag_id, 'Removed');
    });
    document.getElementById('scannedEditButton').addEventListener('click', showScannedToolEditor);
    document.getElementById('cancelScannedEditButton').addEventListener('click', hideScannedToolEditor);
    document.getElementById('scannedEditForm').addEventListener('submit', event => {
        event.preventDefault();
        saveScannedToolName();
    });
    document.getElementById('scannedDeleteButton').addEventListener('click', () => {
        if (scannedTool) deleteTool(scannedTool.tag_id);
    });
    initializeReaderEvents();
    setInterval(pollReaderEvents, 300);
    pollReaderStatus();
    setInterval(pollReaderStatus, 5000);
});

function revealApplication() {
    document.body.classList.remove('is-booting');
    document.body.classList.add('is-booted');
    renderInventory();
}

let scannerBuffer = '';
let lastScannerKeyAt = 0;
let scannerInputTimer;
let lastReaderEventId = 0;
let pollingReaderEvents = false;
let scannerInputIsFast = true;
let readerStatusAvailable = false;
let inventoryTools = [];
let scannedTool = null;
let activeScannedTagId = null;
let scannedTagUsesReaderEvents = false;
let readerEventsInitialized = false;
const visibilityAnimations = new WeakMap();
let activeScroll = null;
let statusFilterCloseTimer = 0;
let scannedToolDismissTimer = 0;
let inventoryLoadError = null;

function animateText(element, text) {
    const message = String(text);
    const fragment = document.createDocumentFragment();
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    [...message].forEach((character, index) => {
        const span = document.createElement('span');
        span.className = 'typing-char';
        span.textContent = character;
        span.setAttribute('aria-hidden', 'true');
        span.style.setProperty(
            '--character-delay',
            reducedMotion ? '0ms' : `${Math.min(index, 24) * 12}ms`
        );
        fragment.appendChild(span);
    });

    element.setAttribute('aria-label', message);
    element.replaceChildren(fragment);
}

function initializeStatusFilter() {
    const select = document.getElementById('statusFilter');
    const trigger = document.getElementById('statusFilterButton');
    const label = document.getElementById('statusFilterLabel');
    const menu = document.getElementById('statusFilterOptions');
    const options = [...menu.querySelectorAll('[role="option"]')];

    const syncSelectedOption = () => {
        const selectedOption = options.find(option => option.dataset.value === select.value);
        if (!selectedOption) return;
        label.textContent = selectedOption.textContent;
        options.forEach(option => {
            option.setAttribute('aria-selected', String(option === selectedOption));
        });
    };

    const openMenu = direction => {
        window.clearTimeout(statusFilterCloseTimer);
        menu.classList.remove('is-closing');
        menu.hidden = false;
        trigger.setAttribute('aria-expanded', 'true');
        const selectedIndex = Math.max(
            0,
            options.findIndex(option => option.dataset.value === select.value)
        );
        const focusIndex = direction === 'last'
            ? options.length - 1
            : direction === 'first'
                ? 0
                : selectedIndex;
        options[focusIndex].focus();
    };

    const closeMenu = (returnFocus = false) => {
        if (menu.hidden) return;
        window.clearTimeout(statusFilterCloseTimer);
        trigger.setAttribute('aria-expanded', 'false');
        menu.classList.add('is-closing');
        statusFilterCloseTimer = window.setTimeout(() => {
            menu.hidden = true;
            menu.classList.remove('is-closing');
        }, 150);
        if (returnFocus) trigger.focus();
    };

    trigger.addEventListener('click', () => {
        if (trigger.getAttribute('aria-expanded') === 'true') {
            closeMenu();
        } else {
            openMenu();
        }
    });

    trigger.addEventListener('keydown', event => {
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            openMenu('first');
        } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            openMenu('last');
        }
    });

    options.forEach((option, index) => {
        option.addEventListener('click', () => {
            select.value = option.dataset.value;
            syncSelectedOption();
            select.dispatchEvent(new Event('change', { bubbles: true }));
            closeMenu(true);
        });

        option.addEventListener('keydown', event => {
            let nextIndex = index;
            if (event.key === 'ArrowDown') nextIndex = (index + 1) % options.length;
            else if (event.key === 'ArrowUp') nextIndex = (index - 1 + options.length) % options.length;
            else if (event.key === 'Home') nextIndex = 0;
            else if (event.key === 'End') nextIndex = options.length - 1;
            else if (event.key === 'Escape') {
                event.preventDefault();
                closeMenu(true);
                return;
            } else if (event.key === 'Tab') {
                closeMenu();
                return;
            } else {
                return;
            }

            event.preventDefault();
            options[nextIndex].focus();
        });
    });

    document.addEventListener('click', event => {
        if (!event.target.closest('.filter-select')) closeMenu();
    });

    syncSelectedOption();
}

async function initializeReaderEvents() {
    try {
        const latestResponse = await fetch('/api/reader/events/latest');
        if (latestResponse.ok) {
            const data = await latestResponse.json();
            lastReaderEventId = data.latest_id;
        } else if (latestResponse.status === 404) {
            const eventsResponse = await fetch('/api/reader/events?after=0');
            if (!eventsResponse.ok) {
                throw new Error(`Could not read existing scans (${eventsResponse.status})`);
            }
            const existingEvents = await eventsResponse.json();
            lastReaderEventId = existingEvents.reduce(
                (latestId, event) => Math.max(latestId, event.id),
                0
            );
        } else {
            throw new Error(`Request failed (${latestResponse.status})`);
        }
        readerEventsInitialized = true;
        await pollReaderEvents();
    } catch (error) {
        console.error('Unable to initialize NFC scan notifications:', error);
        showToast(`Could not connect to live reader scans: ${error.message}`, 'error');
    }
}

async function pollReaderStatus() {
    const indicator = document.getElementById('readerIndicator');
    const statusText = document.getElementById('scanStatus');
    try {
        const response = await fetch('/api/reader/status');
        if (!response.ok) throw new Error(`Request failed (${response.status})`);
        const status = await response.json();
        readerStatusAvailable = status.available;
        indicator.dataset.state = status.available ? 'ready' : 'error';
        statusText.textContent = status.available
            ? 'ACR122U reader ready'
            : `ACR122U unavailable: ${status.message}`;
    } catch (error) {
        readerStatusAvailable = false;
        indicator.dataset.state = 'error';
        statusText.textContent = 'Reader status unavailable. Check that the app is running.';
    }
}

async function pollReaderEvents() {
    if (!readerEventsInitialized || pollingReaderEvents) return;
    pollingReaderEvents = true;
    try {
        const response = await fetch(`/api/reader/events?after=${lastReaderEventId}`);
        if (!response.ok) throw new Error(`Request failed (${response.status})`);
        const events = await response.json();
        for (const event of events) {
            lastReaderEventId = event.id;
            if (event.action === 'removed') {
                handleTagRemoved(event.tag_id);
            } else {
                await showScanResult(event.tag_id, event.result, true);
            }
        }
    } catch (error) {
        console.error('Error checking NFC reader scans:', error);
    } finally {
        pollingReaderEvents = false;
    }
}

function captureUsbScannerInput(event) {
    const target = event.target;
    if (target instanceof HTMLElement &&
        (target.isContentEditable || target.matches('input, textarea, select'))) {
        scannerBuffer = '';
        clearTimeout(scannerInputTimer);
        return;
    }

    if (event.key === 'Enter') {
        if (scannerBuffer.length >= 4) processScan(scannerBuffer);
        scannerBuffer = '';
        clearTimeout(scannerInputTimer);
        return;
    }
    if (event.key.length !== 1 || event.ctrlKey || event.altKey || event.metaKey) return;

    const now = Date.now();
    if (now - lastScannerKeyAt > 100) {
        scannerBuffer = '';
        scannerInputIsFast = true;
    } else if (now - lastScannerKeyAt > 45) {
        scannerInputIsFast = false;
    }
    scannerBuffer += event.key;
    lastScannerKeyAt = now;
    clearTimeout(scannerInputTimer);
    scannerInputTimer = setTimeout(() => {
        if (scannerInputIsFast && scannerBuffer.length >= 4) {
            processScan(scannerBuffer);
        }
        scannerBuffer = '';
    }, 150);
}

// Fetch inventory from Python/SQLite backend
async function fetchTools(render = true) {
    try {
        const response = await fetch('/api/tools');
        if (!response.ok) throw new Error(`Request failed (${response.status})`);
        inventoryTools = await response.json();
        inventoryLoadError = null;
        if (render) renderInventory();
    } catch (error) {
        console.error("Error fetching tools:", error);
        inventoryLoadError = 'Unable to load inventory.';
        if (render) document.getElementById('inventoryTable').textContent = inventoryLoadError;
    }
}

// Render inventory items into table
function renderInventory() {
    const tbody = document.getElementById('inventoryTable');
    if (inventoryLoadError) {
        tbody.textContent = inventoryLoadError;
        return;
    }
    const query = document.getElementById('inventorySearch').value.trim().toLowerCase();
    const statusFilter = document.getElementById('statusFilter').value;
    const tools = inventoryTools.filter(tool => {
        const matchesQuery = `${tool.name} ${tool.tag_id}`.toLowerCase().includes(query);
        const matchesStatus = statusFilter === 'all' || tool.status === statusFilter;
        return matchesQuery && matchesStatus;
    });
    document.getElementById('inventoryCount').textContent =
        `${tools.length} ${tools.length === 1 ? 'tool' : 'tools'}`;
    tbody.innerHTML = '';

    if (tools.length === 0) {
        const row = document.createElement('tr');
        row.className = 'inventory-row';
        const cell = document.createElement('td');
        cell.colSpan = 4;
        cell.className = 'table-message';
        cell.textContent = inventoryTools.length
            ? 'No tools match your search.'
            : 'No tools yet. Scan a tag to add your first tool.';
        row.appendChild(cell);
        tbody.appendChild(row);
        animateRow(row, 0);
        return;
    }

    tools.forEach((tool, index) => {
        const tr = document.createElement('tr');
        tr.className = 'inventory-row';
        const nameCell = document.createElement('td');
        nameCell.className = 'tool-name-cell';
        const name = document.createElement('strong');
        name.textContent = tool.name;
        const editForm = document.createElement('form');
        editForm.className = 'inline-edit-form';
        editForm.hidden = true;
        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.value = tool.name;
        nameInput.maxLength = 120;
        nameInput.required = true;
        nameInput.setAttribute('aria-label', `Edit ${tool.name} name`);
        const saveButton = document.createElement('button');
        saveButton.type = 'submit';
        saveButton.textContent = 'Save';
        const cancelButton = createActionButton('Cancel', () => {
            setAnimatedVisibility(editForm, false);
            setAnimatedVisibility(name, true);
        }, 'secondary-btn');
        editForm.addEventListener('submit', event => {
            event.preventDefault();
            renameTool(tool.tag_id, nameInput.value);
        });
        editForm.append(nameInput, saveButton, cancelButton);
        nameCell.append(name, editForm);
        const tagCell = document.createElement('td');
        tagCell.className = 'tag-id-cell';
        tagCell.textContent = tool.tag_id;
        const statusCell = document.createElement('td');
        const statusBadge = document.createElement('span');
        statusBadge.className = `status-badge ${tool.status === 'Present' ? 'is-present' : 'is-removed'}`;
        statusBadge.textContent = tool.status === 'Present' ? 'In workshop' : 'Checked out';
        statusCell.appendChild(statusBadge);
        const actionsCell = document.createElement('td');
        actionsCell.className = 'tool-actions-cell';
        const actions = document.createElement('div');
        actions.className = 'action-btns';

        const nextStatus = tool.status === 'Present' ? 'Removed' : 'Present';
        const statusLabel = tool.status === 'Present' ? 'Check out' : 'Check in';
        const editButton = createActionButton('Edit', () => {
            setAnimatedVisibility(name, false);
            setAnimatedVisibility(editForm, true);
            nameInput.focus();
            nameInput.select();
        });
        const statusButton = createActionButton(
            statusLabel,
            () => updateStatus(tool.tag_id, nextStatus),
            tool.status === 'Present' ? 'secondary-btn' : ''
        );
        const deleteButton = createActionButton('Delete', () => deleteTool(tool.tag_id));
        deleteButton.className = 'delete-btn';
        actions.append(editButton, statusButton, deleteButton);
        actionsCell.appendChild(actions);
        tr.append(nameCell, tagCell, statusCell, actionsCell);
        tbody.appendChild(tr);
        animateRow(tr, index);
    });
}

function animateRow(row, index) {
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const cells = row.querySelectorAll('td');
    cells.forEach((cell, cellIndex) => {
        cell.animate(
            reducedMotion
                ? [{ opacity: 0 }, { opacity: 1 }]
                : [
                    { opacity: 0, transform: 'translateY(10px)' },
                    { opacity: 1, transform: 'translateY(0)' }
                ],
            {
                duration: reducedMotion ? 180 : 420,
                delay: reducedMotion ? 0 : Math.min(index, 8) * 55 + cellIndex * 35,
                easing: 'cubic-bezier(.22, 1, .36, 1)'
            }
        );
    });
}

function createActionButton(label, action, className = '') {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.className = className;
    button.addEventListener('click', action);
    return button;
}

async function renameTool(tagId, name) {
    name = name.trim();
    if (!name) {
        showToast('Tool name cannot be empty.', 'error');
        return;
    }

    try {
        const response = await fetch(`/api/tools/${encodeURIComponent(tagId)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name })
        });
        if (!response.ok) {
            const data = await response.json();
            throw new Error(data.error || 'Unable to save tool name.');
        }

        const tool = inventoryTools.find(item => item.tag_id === tagId);
        if (tool) tool.name = name;
        if (scannedTool && scannedTool.tag_id === tagId) {
            scannedTool.name = name;
            renderScannedTool();
        }
        await fetchTools();
        showToast('Tool name updated.', 'success');
        return true;
    } catch (error) {
        showToast(error.message, 'error');
        return false;
    }
}

// Add a tool to the database
async function addTool() {
    const name = document.getElementById('toolName').value.trim();
    const tagId = document.getElementById('tagIdInput').value.trim();
    const addButton = document.getElementById('addToolButton');

    if (!name || !tagId) {
        showToast('Enter a tool name before registering this tag.', 'error');
        return;
    }

    addButton.disabled = true;
    addButton.textContent = 'Registering…';
    try {
        const response = await fetch('/api/tools', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tag_id: tagId, name: name })
        });
        if (!response.ok) {
            const data = await response.json();
            throw new Error(data.error || 'Failed to add tool.');
        }
        document.getElementById('toolName').value = '';
        document.getElementById('tagIdInput').value = '';
        setAnimatedVisibility(document.getElementById('addToolCard'), false);
        const resultSpan = document.getElementById('scanResult');
        animateText(resultSpan, `Registered "${name}" — Status: Checked out`);
        resultSpan.className = 'status-removed';
        scannedTool = { tag_id: tagId, name, status: 'Removed' };
        renderScannedTool();
        if (!scannedTagUsesReaderEvents) scheduleScannedToolDismiss(tagId);
        showToast(`"${name}" registered successfully.`, 'success');
        await fetchTools();
    } catch (error) {
        showToast(error.message, 'error');
    } finally {
        addButton.disabled = false;
        addButton.textContent = 'Register tool';
    }
}

function hideAddToolForm() {
    setAnimatedVisibility(document.getElementById('addToolCard'), false);
    document.getElementById('toolName').value = '';
    document.getElementById('tagIdInput').value = '';
    document.getElementById('scanFeedback').dataset.state = 'idle';
    animateText(document.getElementById('scanResult'), 'Registration cancelled.');
}

function showToast(message, kind = 'success') {
    const region = document.getElementById('toastRegion');
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.dataset.kind = kind;
    toast.textContent = message;
    region.appendChild(toast);
    window.setTimeout(() => {
        toast.classList.add('is-leaving');
        window.setTimeout(() => toast.remove(), 240);
    }, 4000);
}

// Scan a tag and show the registration form only for unknown tags.
async function processScan(tagId) {
    tagId = tagId.trim();
    if (!tagId) return;
    animateText(document.getElementById('lastScannedId'), tagId);

    try {
        const response = await fetch('/api/scan', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tag_id: tagId })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Unable to scan tag.');
        await showScanResult(tagId, data);
    } catch (error) {
        replayAnimation(document.getElementById('scanFeedback'));
        const resultSpan = document.getElementById('scanResult');
        animateText(resultSpan, error.message);
        resultSpan.className = 'status-removed';
    }
}

async function showScanResult(tagId, data, readerScan = false) {
    const resultSpan = document.getElementById('scanResult');
    const feedback = document.getElementById('scanFeedback');
    window.clearTimeout(scannedToolDismissTimer);
    activeScannedTagId = tagId;
    scannedTagUsesReaderEvents = readerScan;
    replayAnimation(feedback);
    animateText(document.getElementById('lastScannedId'), tagId);

    if (!data.found) {
        scannedTool = null;
        setAnimatedVisibility(document.getElementById('scannedToolCard'), false);
        feedback.dataset.state = 'new';
        document.getElementById('tagIdInput').value = tagId;
        document.getElementById('toolName').value = '';
        setAnimatedVisibility(document.getElementById('addToolCard'), true);
        animateText(resultSpan, 'New tag — add a name to register it.');
        resultSpan.className = '';
        smoothScrollTo(document.getElementById('addToolCard'));
        document.getElementById('toolName').focus({ preventScroll: true });
        return;
    }

    feedback.dataset.state = 'found';
    setAnimatedVisibility(document.getElementById('addToolCard'), false);
    animateText(resultSpan, `${data.name} · ${data.status === 'Present' ? 'in workshop' : 'checked out'}`);
    resultSpan.className = '';
    scannedTool = { tag_id: tagId, name: data.name, status: data.status };
    renderScannedTool();
    if (!readerScan) scheduleScannedToolDismiss(tagId);
    smoothScrollTo(document.getElementById('scannedToolCard'));
    await fetchTools();
}

function renderScannedTool() {
    if (!scannedTool) return;
    const card = document.getElementById('scannedToolCard');
    const isPresent = scannedTool.status === 'Present';
    const badge = document.getElementById('scannedToolStatus');

    setAnimatedVisibility(card, true);
    setAnimatedVisibility(document.getElementById('scannedEditForm'), false);
    setAnimatedVisibility(document.getElementById('scannedToolActions'), true);
    document.getElementById('scannedToolHeading').textContent = scannedTool.name;
    document.getElementById('scannedToolTagId').textContent = `Tag ID: ${scannedTool.tag_id}`;
    badge.textContent = isPresent ? 'In workshop' : 'Checked out';
    badge.className = `status-badge ${isPresent ? 'is-present' : 'is-removed'}`;
    document.getElementById('scannedCheckInButton').disabled = isPresent;
    document.getElementById('scannedCheckOutButton').disabled = !isPresent;
}

function handleTagRemoved(tagId) {
    if (activeScannedTagId !== tagId) return;
    window.clearTimeout(scannedToolDismissTimer);
    replayAnimation(document.getElementById('scanFeedback'));
    scannedToolDismissTimer = window.setTimeout(() => {
        if (activeScannedTagId !== tagId) return;
        activeScannedTagId = null;
        scannedTagUsesReaderEvents = false;
        scannedTool = null;
        setAnimatedVisibility(document.getElementById('scannedToolCard'), false);
        setAnimatedVisibility(document.getElementById('addToolCard'), false);
        document.getElementById('scanFeedback').dataset.state = 'idle';
        animateText(
            document.getElementById('scanResult'),
            'Tag removed. Scan another tag when ready.'
        );
    }, 500);
}

function scheduleScannedToolDismiss(tagId) {
    window.clearTimeout(scannedToolDismissTimer);
    scannedToolDismissTimer = window.setTimeout(() => {
        if (!scannedTool || scannedTool.tag_id !== tagId) return;
        activeScannedTagId = null;
        scannedTagUsesReaderEvents = false;
        scannedTool = null;
        setAnimatedVisibility(document.getElementById('scannedToolCard'), false);
    }, 2500);
}

function replayAnimation(element) {
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    element.animate(
        reducedMotion
            ? [{ opacity: 0.75 }, { opacity: 1 }]
            : [
                { opacity: 0.65, transform: 'translateY(4px)' },
                { opacity: 1, transform: 'translateY(0)' }
            ],
        { duration: reducedMotion ? 160 : 220, easing: 'cubic-bezier(.16, 1, .3, 1)' }
    );
}

function setAnimatedVisibility(element, visible) {
    const currentAnimation = visibilityAnimations.get(element);
    if (!visible && element.hidden) return;
    if (currentAnimation) {
        currentAnimation.cancel();
        visibilityAnimations.delete(element);
    }

    if (visible) {
        element.hidden = false;
        if (element.id === 'scannedToolCard') element.style.overflow = '';
    }

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let keyframes = reducedMotion
        ? visible
            ? [{ opacity: 0 }, { opacity: 1 }]
            : [{ opacity: 1 }, { opacity: 0 }]
        : visible
            ? [
            { opacity: 0, transform: 'translateY(8px)' },
            { opacity: 1, transform: 'translateY(0)' }
        ]
            : [
                { opacity: 1, transform: 'translateY(0)' },
                { opacity: 0, transform: 'translateY(-5px)' }
            ];

    if (!visible && element.id === 'scannedToolCard') {
        const style = getComputedStyle(element);
        const height = element.getBoundingClientRect().height;
        element.style.overflow = 'hidden';
        keyframes = [
            {
                opacity: 1,
                transform: 'translateY(0)',
                height: `${height}px`,
                marginTop: style.marginTop,
                paddingTop: style.paddingTop,
                paddingBottom: style.paddingBottom,
                borderWidth: style.borderWidth
            },
            {
                opacity: 0,
                transform: reducedMotion ? 'translateY(0)' : 'translateY(-5px)',
                height: '0px',
                marginTop: '0px',
                paddingTop: '0px',
                paddingBottom: '0px',
                borderWidth: '0px'
            }
        ];
    }

    const animation = element.animate(
        keyframes,
        {
            duration: reducedMotion ? 180 : 420,
            easing: 'cubic-bezier(.4, 0, .2, 1)',
            fill: 'both'
        }
    );
    visibilityAnimations.set(element, animation);
    animation.onfinish = () => {
        if (visibilityAnimations.get(element) !== animation) return;
        visibilityAnimations.delete(element);
        if (!visible) element.hidden = true;
        animation.cancel();
        if (element.id === 'scannedToolCard') element.style.overflow = '';
    };
}

function smoothScrollTo(element) {
    const bounds = element.getBoundingClientRect();
    const outsideViewport = bounds.top < 0 || bounds.bottom > window.innerHeight;
    if (!outsideViewport) return;
    const root = document.documentElement;
    if (activeScroll) {
        window.cancelAnimationFrame(activeScroll.frame);
        root.style.scrollBehavior = activeScroll.originalBehavior;
    }

    const maxTop = root.scrollHeight - window.innerHeight;
    const targetTop = Math.min(
        maxTop,
        Math.max(0, window.scrollY + bounds.top - Math.max(24, (window.innerHeight - bounds.height) / 3))
    );
    const startTop = window.scrollY;
    if (Math.abs(targetTop - startTop) < 2) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        window.scrollTo(0, targetTop);
        return;
    }

    const scroll = {
        frame: 0,
        originalBehavior: root.style.scrollBehavior,
        startTime: performance.now(),
    };
    activeScroll = scroll;
    root.style.scrollBehavior = 'auto';

    const step = currentTime => {
        const progress = Math.min((currentTime - scroll.startTime) / 390, 1);
        const easedProgress = progress < 0.5
            ? 4 * Math.pow(progress, 3)
            : 1 - Math.pow(-2 * progress + 2, 3) / 2;
        window.scrollTo(0, startTop + (targetTop - startTop) * easedProgress);

        if (progress < 1) {
            scroll.frame = window.requestAnimationFrame(step);
            return;
        }

        root.style.scrollBehavior = scroll.originalBehavior;
        activeScroll = null;
    };
    scroll.frame = window.requestAnimationFrame(step);
}

function showScannedToolEditor() {
    if (!scannedTool) return;
    setAnimatedVisibility(document.getElementById('scannedToolActions'), false);
    setAnimatedVisibility(document.getElementById('scannedEditForm'), true);
    const input = document.getElementById('scannedNameInput');
    input.value = scannedTool.name;
    input.focus();
    input.select();
}

function hideScannedToolEditor() {
    setAnimatedVisibility(document.getElementById('scannedEditForm'), false);
    setAnimatedVisibility(document.getElementById('scannedToolActions'), true);
}

async function saveScannedToolName() {
    if (!scannedTool) return;
    const input = document.getElementById('scannedNameInput');
    const name = input.value.trim();
    if (!name) {
        showToast('Tool name cannot be empty.', 'error');
        return;
    }

    const tagId = scannedTool.tag_id;
    const saveButton = document.getElementById('saveScannedNameButton');
    saveButton.disabled = true;
    try {
        const saved = await renameTool(tagId, name);
        if (saved && scannedTool && scannedTool.tag_id === tagId) hideScannedToolEditor();
    } finally {
        saveButton.disabled = false;
    }
}

// Update status button click (Present / Removed)
async function updateStatus(tagId, status) {
    if (!tagId) return;
    try {
        const response = await fetch('/api/status', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tag_id: tagId, status: status })
        });
        if (!response.ok) {
            const data = await response.json();
            throw new Error(data.error || 'Unable to update status.');
        }
        const tool = inventoryTools.find(item => item.tag_id === tagId);
        if (tool) tool.status = status;
        if (scannedTool && scannedTool.tag_id === tagId) {
            scannedTool.status = status;
            animateText(
                document.getElementById('scanResult'),
                `${scannedTool.name} · ${status === 'Present' ? 'in workshop' : 'checked out'}`
            );
            renderScannedTool();
        }
        await fetchTools();
        showToast(status === 'Present' ? 'Tool checked in.' : 'Tool checked out.', 'success');
    } catch (error) {
        showToast(error.message, 'error');
    }
}

// Delete tool from database completely
async function deleteTool(tagId) {
    if (!confirm('Are you sure you want to delete this tool?')) return;

    try {
        const response = await fetch(`/api/tools/${encodeURIComponent(tagId)}`, {
            method: 'DELETE'
        });
        if (!response.ok) {
            const data = await response.json();
            throw new Error(data.error || 'Unable to delete tool.');
        }
        if (scannedTool && scannedTool.tag_id === tagId) {
            scannedTool = null;
            setAnimatedVisibility(document.getElementById('scannedToolCard'), false);
        }
        await fetchTools();
    } catch (error) {
        showToast(error.message, 'error');
    }
}

// Web NFC capability (for Chrome on Android)
async function startWebNFC() {
    const statusText = document.getElementById('scanStatus');
    if (!('NDEFReader' in window)) {
        showToast('Web NFC is not supported in this browser. Use the connected ACR122U or a keyboard-style scanner.', 'error');
        return;
    }

    try {
        const ndef = new NDEFReader();
        document.getElementById('webNfcButton').disabled = true;
        document.getElementById('webNfcButton').textContent = 'Starting…';
        await ndef.scan();
        statusText.textContent = 'Web NFC ready';
        document.getElementById('readerIndicator').dataset.state = 'ready';
        
        ndef.onreading = (event) => {
            if (event.serialNumber) {
                processScan(event.serialNumber);
            } else {
                showToast('This NFC tag did not provide a serial number.', 'error');
            }
        };
    } catch (error) {
        document.getElementById('readerIndicator').dataset.state =
            readerStatusAvailable ? 'ready' : 'error';
        showToast(`Could not start Web NFC: ${error.message}`, 'error');
    } finally {
        document.getElementById('webNfcButton').disabled = false;
        document.getElementById('webNfcButton').textContent = 'Enable Web NFC';
    }
}
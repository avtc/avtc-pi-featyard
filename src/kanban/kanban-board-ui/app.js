// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

const WEB_UI_SESSION = "web-ui";
// Lane order must match LANE_ORDER in types.ts — kept in sync manually.
const LANES = ["backlog", "design", "design-approval", "ready", "in-progress", "uat", "done"];

const LANE_LABELS = {
  backlog: "Backlog",
  design: "Design",
  "design-approval": "Design Approval",
  ready: "Ready",
  "in-progress": "In Progress",
  uat: "UAT",
  done: "Done",
};

const LANE_COLORS = {
  backlog: "#6b7280",
  design: "#8b5cf6",
  "design-approval": "#f59e0b",
  ready: "#3b82f6",
  "in-progress": "#10b981",
  uat: "#ec4899",
  done: "#6366f1",
};

let currentProjectId = null;
let boardData = {};
let refreshInterval = null;
let scrollPauseTimeout = null;
let contextMenuEl = null;
let contextMenuFeatureId = null;
let contextMenuFeatureTitle = null;
let contextMenuFeatureLocked = false;

// Within-lane drag-and-drop reorder state
let insertionLineEl = null;
let draggedFeatureId = null;
let draggedFeatureLane = null;
let lastInsertionTarget = null;
let lastInsertionPosition = null;

/** Enable/disable action buttons based on whether a project is selected. */
function updateActionButtons() {
  for (const id of ["add-btn", "import-btn", "export-btn"]) {
    const btn = document.getElementById(id);
    if (btn) btn.disabled = !currentProjectId;
  }
}

/** Find a feature by ID from the current boardData. */
function findFeatureById(id) {
  for (const lane of LANES) {
    const features = boardData[lane] || [];
    const found = features.find((f) => f.id === id);
    if (found) return found;
  }
  return null;
}

const MAX_CONFIRM_TITLE_LENGTH = 100;

/** Shared delete flow: confirm → API call → refresh. */
async function deleteFeature(featureId, title) {
  const safeTitle = title.length > MAX_CONFIRM_TITLE_LENGTH ? `${title.slice(0, MAX_CONFIRM_TITLE_LENGTH)}…` : title;
  if (!confirm(`Delete feature "${safeTitle}"? This cannot be undone.`)) return;
  try {
    await api(`/api/features/${featureId}`, { method: "DELETE" });
    document.getElementById("detail-modal").classList.add("hidden");
    hideContextMenu();
    await loadBoard();
  } catch (err) {
    if (err.status === 409) {
      alert("This feature was locked by another process. Release the lock first and try again.");
    } else {
      alert(`Failed to delete feature: ${err.message || ""}`);
    }
  }
}

/** Shared release flow: API call → close modal → refresh. Re-throws on error so callers can handle it. */
async function releaseFeature(featureId) {
  try {
    await api(`/api/features/${featureId}/release`, { method: "POST" });
    document.getElementById("detail-modal").classList.add("hidden");
    hideContextMenu();
    await loadBoard();
  } catch (err) {
    alert(`Failed to release lock: ${err.message}`);
    throw err; // Re-throw so caller can restore button state
  }
}

/** Shared lock flow: API call → close modal → refresh. Re-throws on error so callers can handle it. */
async function lockFeature(featureId) {
  try {
    await api(`/api/features/${featureId}/lock`, { method: "POST" });
    document.getElementById("detail-modal").classList.add("hidden");
    hideContextMenu();
    await loadBoard();
  } catch (err) {
    alert(`Failed to lock feature: ${err.message}`);
    throw err;
  }
}

/** Hide the context menu. */
function hideContextMenu() {
  if (contextMenuEl) contextMenuEl.classList.add("hidden");
}

/** Show the context menu at the given position for the given feature. */
function showContextMenu(x, y, feature) {
  contextMenuFeatureId = feature.id;
  contextMenuFeatureTitle = feature.title;
  contextMenuFeatureLocked = !!feature.locked_at;

  // Update menu items
  const lockItem = contextMenuEl.querySelector(".ctx-lock");
  const releaseItem = contextMenuEl.querySelector(".ctx-release");
  const deleteItem = contextMenuEl.querySelector(".ctx-delete");
  lockItem.style.display = contextMenuFeatureLocked ? "none" : "block";
  releaseItem.style.display = contextMenuFeatureLocked ? "block" : "none";
  if (contextMenuFeatureLocked) {
    deleteItem.classList.add("disabled");
    deleteItem.title = "Release lock first";
  } else {
    deleteItem.classList.remove("disabled");
    deleteItem.title = "";
  }

  // Position: use fixed positioning at mouse coords, clamp to viewport
  contextMenuEl.classList.remove("hidden");
  contextMenuEl.style.left = `${x}px`;
  contextMenuEl.style.top = `${y}px`;

  // Clamp after making visible (need dimensions)
  const rect = contextMenuEl.getBoundingClientRect();
  if (rect.right > window.innerWidth) {
    contextMenuEl.style.left = `${window.innerWidth - rect.width - 8}px`;
  }
  if (rect.bottom > window.innerHeight) {
    contextMenuEl.style.top = `${window.innerHeight - rect.height - 8}px`;
  }
}

// ---- API helpers ----

async function api(path, options = {}) {
  const headers = options.headers || {};
  if (window.__KANBAN_AUTH_TOKEN) {
    headers.Authorization = `Bearer ${window.__KANBAN_AUTH_TOKEN}`;
  }
  const res = await fetch(path, { ...options, headers });
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    const err = new Error(errBody.error || `API error: ${res.status} ${res.statusText}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// ---- Project selector ----

async function loadProjects() {
  const projects = await api("/api/projects");
  const select = document.getElementById("project-select");
  select.innerHTML = '<option value="">Select project...</option>';
  for (const p of projects) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.name;
    if (String(currentProjectId) === String(p.id)) opt.selected = true;
    select.appendChild(opt);
  }
  if (projects.length === 1) {
    select.value = projects[0].id;
    currentProjectId = projects[0].id;
  } else if (currentProjectId) {
    select.value = currentProjectId;
  }
  updateActionButtons();
  if (currentProjectId) loadBoard();
}

// ---- Board rendering ----

/** Fetch board data and re-render without dismissing UI banners. */
async function refreshBoardData() {
  if (!currentProjectId) return;
  try {
    // Save scroll positions before DOM rebuild
    const scrollPositions = {};
    for (const laneCards of document.querySelectorAll(".lane-cards")) {
      scrollPositions[laneCards.dataset.lane] = laneCards.scrollTop;
    }

    boardData = await api(`/api/board/${currentProjectId}`);
    renderBoard();

    // Restore scroll positions after rebuild
    for (const laneCards of document.querySelectorAll(".lane-cards")) {
      const lane = laneCards.dataset.lane;
      if (scrollPositions[lane] != null) {
        laneCards.scrollTop = scrollPositions[lane];
      }
    }
  } catch (err) {
    console.error("Failed to load board:", err);
  }
}

/** Full board refresh — also dismisses import banner and context menu. */
async function loadBoard() {
  if (!currentProjectId) return;
  hideContextMenu();
  // Dismiss import banner on board refresh
  const banner = document.getElementById("import-banner");
  if (banner) banner.classList.add("hidden");
  await refreshBoardData();
}

function showInsertionLine(card, position) {
  // Skip DOM work if insertion line hasn't moved
  if (card === lastInsertionTarget && position === lastInsertionPosition) return;
  lastInsertionTarget = card;
  lastInsertionPosition = position;
  const rect = card.getBoundingClientRect();
  const laneCards = card.closest(".lane-cards");
  const laneRect = laneCards.getBoundingClientRect();
  insertionLineEl.classList.remove("hidden");
  insertionLineEl.style.left = `${rect.left - laneRect.left + 4}px`;
  insertionLineEl.style.width = `${rect.width - 8}px`;
  if (position === "before") {
    insertionLineEl.style.top = `${rect.top - laneRect.top + laneCards.scrollTop - 1}px`;
  } else {
    insertionLineEl.style.top = `${rect.bottom - laneRect.top + laneCards.scrollTop - 1}px`;
  }
  // Position relative to the lane-cards container
  laneCards.style.position = "relative";
  laneCards.appendChild(insertionLineEl);
}

function hideInsertionLine() {
  insertionLineEl.classList.add("hidden");
  lastInsertionTarget = null;
  lastInsertionPosition = null;
}

function cleanupDrag() {
  hideInsertionLine();
  draggedFeatureId = null;
  draggedFeatureLane = null;
}

function renderBoard() {
  // Note: hideContextMenu() intentionally NOT called here.
  // Auto-refresh calls renderBoard via loadBoard; we don't want to
  // dismiss the context menu while the user is interacting with it.
  const board = document.getElementById("board");
  board.innerHTML = "";

  for (const lane of LANES) {
    const features = boardData[lane] || [];
    const laneEl = document.createElement("div");
    laneEl.className = "lane";
    laneEl.style.setProperty("--lane-color", LANE_COLORS[lane]);
    laneEl.dataset.lane = lane;

    laneEl.innerHTML = `
      <div class="lane-header">
        <span>${LANE_LABELS[lane]}</span>
        <span class="lane-count">${features.length}</span>
      </div>
      <div class="lane-cards" data-lane="${lane}"></div>
    `;

    const cardsContainer = laneEl.querySelector(".lane-cards");

    // Sort by priority (higher number = higher priority, matches DB ORDER BY DESC)
    features.sort((a, b) => b.priority - a.priority);

    for (const f of features) {
      const card = createCard(f);
      cardsContainer.appendChild(card);
    }

    // Drop zone
    setupDropZone(cardsContainer, lane);
    board.appendChild(laneEl);
  }
}

function createCard(feature) {
  const card = document.createElement("div");
  const overlayClass = feature.overlay_status ? ` overlay-${feature.overlay_status}` : "";
  card.className = `card${feature.locked_at ? " locked" : ""}${overlayClass}`;
  card.draggable = !feature.overlay_status;
  card.dataset.featureId = feature.id;

  card.innerHTML = `
    <div class="card-title">${escapeHtml(feature.title)}</div>
    <div class="card-slug">${escapeHtml(feature.slug)}</div>
    <div class="card-id">#${feature.id}</div>
    ${feature.priority > 0 ? `<div class="card-priority">P${feature.priority}</div>` : ""}
    ${feature.overlay_status === "waiting-for-response" ? '<div class="overlay-indicator">⏳ Waiting for response</div>' : ""}
    ${feature.locked_at && !feature.overlay_status ? '<div class="lock-indicator">🔒 Locked</div>' : ""}
  `;

  // Drag
  card.addEventListener("dragstart", (e) => {
    e.dataTransfer.setData("text/plain", String(feature.id));
    e.dataTransfer.setData("application/x-lane", feature.lane);
    draggedFeatureId = feature.id;
    draggedFeatureLane = feature.lane;
    card.classList.add("dragging");
    // Pause auto-refresh during drag to prevent DOM invalidation
    stopAutoRefresh();
  });
  card.addEventListener("dragend", () => {
    card.classList.remove("dragging");
    cleanupDrag();
    // Resume auto-refresh after drag
    startAutoRefresh();
  });

  // Within-lane and cross-lane dragover — show insertion line
  // Note: locked target cards are valid drop targets per spec — insertion line should show
  card.addEventListener("dragover", (e) => {
    if (!draggedFeatureId) return;
    e.preventDefault();
    const rect = card.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    const position = e.clientY < midY ? "before" : "after";
    showInsertionLine(card, position);
  });

  // Within-lane drop — reorder
  card.addEventListener("drop", (e) => handleCardDrop(e, card));

  // Click to show details
  card.addEventListener("click", (_e) => {
    if (!card.classList.contains("dragging")) showDetail(feature);
  });

  return card;
}

/** Handle drop on a card — works for both within-lane reorder and cross-lane move with precise placement. */
function handleCardDrop(e, card) {
  if (!draggedFeatureId) return;
  const container = card.closest(".lane-cards");
  const targetLane = container.dataset.lane;
  const isCrossLane = targetLane !== draggedFeatureLane;

  e.stopPropagation();
  e.preventDefault();

  const rect = card.getBoundingClientRect();
  const midY = rect.top + rect.height / 2;
  const insertBefore = e.clientY < midY;

  // Build new ordering of cards in the target lane
  const cards = [...container.querySelectorAll(".card")];
  const draggedCard = isCrossLane
    ? null // card doesn't exist in target lane yet
    : cards.find((c) => c.dataset.featureId === String(draggedFeatureId));

  if (!isCrossLane && !draggedCard) {
    cleanupDrag();
    return;
  }

  // Remove dragged card from list (within-lane only — it won't be in the list for cross-lane)
  const filtered = isCrossLane ? cards : cards.filter((c) => c !== draggedCard);

  // Find insertion index
  const targetIndex = filtered.indexOf(card);
  if (targetIndex === -1) {
    cleanupDrag();
    return;
  }
  const insertIndex = insertBefore ? targetIndex : targetIndex + 1;

  if (isCrossLane) {
    // Cross-lane: move first, then reorder
    handleCrossLaneDrop(draggedFeatureId, targetLane, filtered, insertIndex);
  } else {
    // Within-lane: reorder only
    handleWithinLaneReorder(cards, draggedCard, filtered, insertIndex, targetLane);
  }
}

/** Build a feature lookup map from current boardData to avoid repeated linear scans. */
function buildFeatureMap(targetLane) {
  const map = new Map();
  const lanes = targetLane ? [targetLane] : LANES;
  for (const laneKey of lanes) {
    for (const f of boardData[laneKey] || []) {
      map.set(f.id, f);
    }
  }
  return map;
}

/** Handle within-lane reorder after a drop. */
async function handleWithinLaneReorder(cards, draggedCard, filtered, insertIndex, lane) {
  filtered.splice(insertIndex, 0, draggedCard);

  // Build feature lookup map for target lane only
  const featureMap = buildFeatureMap(lane);

  // Collect unlocked feature IDs in new order
  const featureIds = filtered
    .filter((c) => {
      const f = featureMap.get(Number(c.dataset.featureId));
      return f && !f.locked_at;
    })
    .map((c) => Number(c.dataset.featureId));

  // Check if order actually changed
  const originalIds = cards
    .filter((c) => {
      const f = featureMap.get(Number(c.dataset.featureId));
      return f && !f.locked_at;
    })
    .map((c) => Number(c.dataset.featureId));

  const orderChanged = featureIds.length !== originalIds.length || featureIds.some((id, i) => id !== originalIds[i]);
  if (!orderChanged) {
    cleanupDrag();
    return;
  }

  if (featureIds.length < 2) {
    cleanupDrag();
    return;
  }

  // Call reorder API
  try {
    await api("/api/features/reorder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ featureIds, projectId: currentProjectId, lane }),
    });
    await refreshBoardData();
  } catch (err) {
    alert(`Failed to reorder: ${err.message || ""}`);
  } finally {
    cleanupDrag();
  }
}

/** Handle cross-lane move with precise placement after a drop. */
async function handleCrossLaneDrop(featureId, targetLane, existingCards, insertIndex) {
  try {
    // Step 1: Move the card to the new lane (position doesn't matter, we'll reorder)
    await api(`/api/features/${featureId}/move`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ toLane: targetLane, changedBy: WEB_UI_SESSION, position: "top" }),
    });

    // Step 2: Build the desired ordering with the moved card inserted
    // Collect existing feature IDs (excluding locked) using DOM class — avoids stale boardData
    const existingIds = existingCards
      .filter((c) => !c.classList.contains("locked"))
      .map((c) => Number(c.dataset.featureId));

    // Insert the moved card at the desired position
    const movedId = Number(featureId);
    existingIds.splice(insertIndex, 0, movedId);

    if (existingIds.length < 2) {
      await loadBoard();
      cleanupDrag();
      return;
    }

    // Step 3: Reorder to place the moved card at the exact position
    try {
      await api("/api/features/reorder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ featureIds: existingIds, projectId: currentProjectId, lane: targetLane }),
      });
    } catch (reorderErr) {
      // Move succeeded but reorder failed — refresh to show actual state
      await refreshBoardData();
      alert(`Card moved to ${targetLane} but exact position could not be set. ${reorderErr.message || ""}`);
      return;
    }

    await refreshBoardData();
  } catch (err) {
    alert(`Failed to move feature: ${err.message || ""}`);
    await refreshBoardData();
  } finally {
    cleanupDrag();
  }
}

function setupDropZone(container, lane) {
  container.addEventListener("dragover", (e) => {
    e.preventDefault();
    // Same-lane drags: per-card handlers show insertion line
    // Cross-lane drags: per-card handlers show insertion line, lane highlight not needed
    if (draggedFeatureLane && draggedFeatureLane === lane) return;
    // Only highlight if not hovering over a card (empty lane area)
    if (e.target.closest(".card")) return;
    container.classList.add("drag-over");
  });
  container.addEventListener("dragleave", () => {
    container.classList.remove("drag-over");
  });
  container.addEventListener("drop", async (e) => {
    e.preventDefault();
    container.classList.remove("drag-over");
    const featureId = e.dataTransfer.getData("text/plain");
    if (!featureId) return;

    // Skip same-lane drops (handled by per-card drop handler)
    const sourceLane = e.dataTransfer.getData("application/x-lane");
    if (sourceLane === lane) return;

    // Check if drop landed directly on the container (not on a card)
    // If it landed on a card, the per-card handler already dealt with it
    const droppedOnCard = e.target.closest(".card");
    if (droppedOnCard) return;

    // Dropped on empty area of lane — move to bottom
    try {
      await api(`/api/features/${featureId}/move`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toLane: lane, changedBy: WEB_UI_SESSION }),
      });
      await loadBoard();
    } catch (err) {
      console.error("Failed to move feature:", err);
    } finally {
      cleanupDrag();
    }
  });
}

// ---- Detail modal with tabs ----

let currentDetailFeature = null;
let detailHistoryLoaded = false;

function switchDetailTab(tabName) {
  document.querySelectorAll(".detail-tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.tab === tabName);
  });
  document.querySelectorAll(".detail-tab-content").forEach((content) => {
    content.classList.remove("active");
  });
  document.getElementById(`detail-tab-${tabName}`).classList.add("active");

  // Lazy-load history when switching to it
  if (tabName === "history" && !detailHistoryLoaded && currentDetailFeature) {
    loadDetailHistory(currentDetailFeature);
  }
}

async function loadDetailHistory(feature) {
  const historyBody = document.getElementById("detail-history-body");
  historyBody.innerHTML = '<p style="color:#64748b">Loading...</p>';
  try {
    const history = await api(`/api/features/${feature.id}/history`);
    if (history.length === 0) {
      historyBody.innerHTML = '<p style="color:#64748b">No history entries.</p>';
    } else {
      let html = "";
      for (const h of history) {
        html += `<div class="history-entry">
          <span class="lane-change">${h.from_lane ?? "—"} → ${h.to_lane}</span>
          by ${escapeHtml(h.changed_by)} <span style="color:#64748b">${new Date(h.created_at).toLocaleString()}</span>
        </div>`;
      }
      historyBody.innerHTML = html;
    }
    detailHistoryLoaded = true;
  } catch {
    historyBody.innerHTML = '<p style="color:#f87171">Failed to load history.</p>';
  }
}

async function showDetail(feature) {
  currentDetailFeature = feature;
  detailHistoryLoaded = false;

  const modal = document.getElementById("detail-modal");
  const isEditable = feature.lane === "backlog";
  const textarea = document.getElementById("detail-description");

  document.getElementById("detail-title").textContent = feature.title;
  document.getElementById("detail-id").textContent = `#${feature.id} · ${escapeHtml(feature.slug)}`;

  // Meta row
  document.getElementById("detail-meta-lane").textContent = LANE_LABELS[feature.lane] || feature.lane;
  document.getElementById("detail-meta-priority").textContent = feature.priority;
  document.getElementById("detail-meta-created").textContent = new Date(feature.created_at).toLocaleDateString();

  // Description textarea — editable for backlog, read-only otherwise
  textarea.value = feature.description || "";
  textarea.readOnly = !isEditable;
  if (isEditable) {
    textarea.classList.remove("readonly");
    textarea.classList.add("editable");
  } else {
    textarea.classList.remove("editable");
    textarea.classList.add("readonly");
  }

  // Save button — only visible for backlog items
  const saveBtn = document.getElementById("detail-save-btn");
  saveBtn.style.display = isEditable ? "inline-block" : "none";

  // Status indicators
  const statusRow = document.getElementById("detail-status-row");
  if (feature.overlay_status === "waiting-for-response") {
    statusRow.innerHTML =
      '<span class="detail-label">Status</span><span class="detail-value overlay-indicator">⏳ Waiting for response</span>';
    statusRow.style.display = "flex";
  } else {
    statusRow.style.display = "none";
  }

  const lockRow = document.getElementById("detail-lock-row");
  if (feature.locked_at) {
    lockRow.innerHTML = `<span class="detail-label">Locked</span><span class="detail-value">🔒 Since ${new Date(feature.locked_at).toLocaleString()}</span>`;
    lockRow.style.display = "flex";
  } else {
    lockRow.style.display = "none";
  }

  // Release lock button
  const releaseBtn = document.getElementById("release-lock-btn");
  releaseBtn.style.display = feature.locked_at ? "block" : "none";
  releaseBtn.disabled = false;
  releaseBtn.textContent = "Release Lock";

  // Lock button (shown when feature is NOT locked)
  const lockBtn = document.getElementById("lock-btn");
  lockBtn.style.display = feature.locked_at ? "none" : "block";
  lockBtn.disabled = false;
  lockBtn.textContent = "Lock Feature";

  // Delete button — disabled when locked
  const deleteBtn = document.getElementById("delete-btn");
  deleteBtn.disabled = !!feature.locked_at;

  // Switch to Details tab
  switchDetailTab("details");
  modal.classList.remove("hidden");
}

// ---- Auto-refresh ----

function startAutoRefresh(intervalMs = 5000) {
  stopAutoRefresh();
  // Use refreshBoardData (not loadBoard) to avoid dismissing context menu
  refreshInterval = setInterval(refreshBoardData, intervalMs);
}

function stopAutoRefresh() {
  if (refreshInterval) {
    clearInterval(refreshInterval);
    refreshInterval = null;
  }
}

// ---- Utilities ----

function escapeHtml(str) {
  if (!str) return "";
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ---- Scroll pause during active scrolling ----

/** Pause auto-refresh while the user is scrolling in any lane, resume 1s after scroll stops. */
function setupScrollPause() {
  const board = document.getElementById("board");
  board.addEventListener(
    "scroll",
    (e) => {
      const laneCards = e.target.closest(".lane-cards");
      if (!laneCards) return;
      stopAutoRefresh();
      clearTimeout(scrollPauseTimeout);
      scrollPauseTimeout = setTimeout(startAutoRefresh, 1000);
    },
    { passive: true },
  );
}

// ---- Init ----

document.addEventListener("DOMContentLoaded", () => {
  // Create insertion line for within-lane reorder
  insertionLineEl = document.createElement("div");
  insertionLineEl.className = "insertion-line hidden";
  document.body.appendChild(insertionLineEl);

  const select = document.getElementById("project-select");
  select.addEventListener("change", () => {
    currentProjectId = select.value ? Number(select.value) : null;
    updateActionButtons();
    loadBoard();
  });

  document.getElementById("refresh-btn").addEventListener("click", loadBoard);

  // ---- Context menu ----
  contextMenuEl = document.createElement("div");
  contextMenuEl.className = "context-menu hidden";
  contextMenuEl.innerHTML = `
    <div class="context-menu-item ctx-lock">Lock Feature</div>
    <div class="context-menu-item ctx-release">Release Lock</div>
    <div class="context-menu-item ctx-delete danger">Delete Feature</div>
  `;
  document.body.appendChild(contextMenuEl);

  // Context menu item click handlers
  contextMenuEl.querySelector(".ctx-lock").addEventListener("click", (e) => {
    e.stopPropagation();
    if (contextMenuFeatureLocked) return;
    if (contextMenuFeatureId !== null) lockFeature(contextMenuFeatureId).catch(() => {});
  });
  contextMenuEl.querySelector(".ctx-release").addEventListener("click", (e) => {
    e.stopPropagation();
    if (contextMenuFeatureId !== null) releaseFeature(contextMenuFeatureId).catch(() => {});
  });
  contextMenuEl.querySelector(".ctx-delete").addEventListener("click", (e) => {
    e.stopPropagation();
    if (contextMenuFeatureLocked) return;
    if (contextMenuFeatureId !== null) deleteFeature(contextMenuFeatureId, contextMenuFeatureTitle);
  });

  // Right-click on board cards → show context menu
  document.getElementById("board").addEventListener("contextmenu", (e) => {
    hideContextMenu(); // Dismiss any existing menu first
    const card = e.target.closest(".card");
    if (!card) return;
    e.preventDefault();
    const featureId = Number(card.dataset.featureId);
    const feature = findFeatureById(featureId);
    if (!feature) return;
    showContextMenu(e.clientX, e.clientY, feature);
  });

  // Dismiss context menu
  document.addEventListener("click", (e) => {
    if (contextMenuEl && !contextMenuEl.contains(e.target)) hideContextMenu();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hideContextMenu();
  });
  document.getElementById("board").addEventListener("scroll", () => hideContextMenu());

  // Detail modal close
  document.querySelector("#detail-modal .modal-close").addEventListener("click", () => {
    document.getElementById("detail-modal").classList.add("hidden");
  });
  document.getElementById("detail-modal").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) e.currentTarget.classList.add("hidden");
  });

  // Detail modal tab switching
  document.querySelectorAll(".detail-tab").forEach((tab) => {
    tab.addEventListener("click", () => switchDetailTab(tab.dataset.tab));
  });

  // Save description (backlog items)
  document.getElementById("detail-save-btn").addEventListener("click", async () => {
    if (!currentDetailFeature) return;
    const saveBtn = document.getElementById("detail-save-btn");
    const textarea = document.getElementById("detail-description");
    const newDesc = textarea.value.trim() || null;
    saveBtn.disabled = true;
    saveBtn.textContent = "Saving...";
    try {
      await api(`/api/features/${currentDetailFeature.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: newDesc }),
      });
      saveBtn.textContent = "Saved ✓";
      refreshBoardData();
      setTimeout(() => {
        saveBtn.textContent = "Save";
        saveBtn.disabled = false;
      }, 1500);
    } catch (err) {
      alert(`Failed to save: ${err.message}`);
      saveBtn.textContent = "Save";
      saveBtn.disabled = false;
    }
  });

  // Release lock (uses shared function, preserves button feedback)
  document.getElementById("release-lock-btn").addEventListener("click", () => {
    if (!currentDetailFeature) return;
    const releaseBtn = document.getElementById("release-lock-btn");
    releaseBtn.disabled = true;
    releaseBtn.textContent = "Releasing...";
    releaseFeature(currentDetailFeature.id).catch((_err) => {
      releaseBtn.disabled = false;
      releaseBtn.textContent = "Release Lock";
    });
  });

  // Lock feature (uses shared function, preserves button feedback)
  document.getElementById("lock-btn").addEventListener("click", () => {
    if (!currentDetailFeature) return;
    const lockBtn = document.getElementById("lock-btn");
    lockBtn.disabled = true;
    lockBtn.textContent = "Locking...";
    lockFeature(currentDetailFeature.id).catch((_err) => {
      lockBtn.disabled = false;
      lockBtn.textContent = "Lock Feature";
    });
  });

  // Delete feature (uses shared function)
  document.getElementById("delete-btn").addEventListener("click", () => {
    if (!currentDetailFeature) return;
    deleteFeature(currentDetailFeature.id, currentDetailFeature.title);
  });

  // Add feature modal
  const addModal = document.getElementById("add-modal");
  const addTitle = document.getElementById("add-title");
  const addDescription = document.getElementById("add-description");
  const addPositionBtns = document.querySelectorAll(".position-toggle-btn");
  let addPosition = "bottom";
  addPositionBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      addPositionBtns.forEach((b) => {
        b.classList.remove("active");
      });
      btn.classList.add("active");
      addPosition = btn.dataset.position;
    });
  });
  const addLane = document.getElementById("add-lane");
  const addSubmitBtn = document.getElementById("add-submit-btn");

  // Populate lane options
  for (const lane of LANES) {
    const opt = document.createElement("option");
    opt.value = lane;
    opt.textContent = LANE_LABELS[lane];
    if (lane === "backlog") opt.selected = true;
    addLane.appendChild(opt);
  }

  // Open modal
  document.getElementById("add-btn").addEventListener("click", () => {
    addTitle.value = "";
    addDescription.value = "";
    addPosition = "bottom";
    addPositionBtns.forEach((b) => {
      b.classList.toggle("active", b.dataset.position === "bottom");
    });
    addLane.value = "backlog";
    addModal.classList.remove("hidden");
  });

  // Generate title from description
  const addGenerateBtn = document.getElementById("add-generate-title-btn");
  addGenerateBtn.addEventListener("click", async () => {
    const description = addDescription.value.trim();
    if (!description) {
      alert("Enter a description first, then generate a title.");
      return;
    }
    addGenerateBtn.disabled = true;
    addGenerateBtn.textContent = "⏳";
    try {
      const result = await api("/api/generate-title", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description }),
      });
      addTitle.value = result.title;
    } catch (err) {
      alert(`Failed to generate title: ${err.message}`);
    } finally {
      addGenerateBtn.disabled = false;
      addGenerateBtn.textContent = "✨";
    }
  });

  // Close modal (× button)
  document.querySelector("#add-modal .modal-close").addEventListener("click", () => {
    addModal.classList.add("hidden");
  });

  // Close modal (backdrop click)
  addModal.addEventListener("click", (e) => {
    if (e.target === e.currentTarget) addModal.classList.add("hidden");
  });

  // Submit
  addSubmitBtn.addEventListener("click", async () => {
    const title = addTitle.value;
    if (title.trim().length === 0) {
      alert("Title is required");
      return;
    }
    addSubmitBtn.disabled = true;
    addSubmitBtn.textContent = "Adding...";
    try {
      await api("/api/features", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: currentProjectId,
          title: title.trim(),
          description: addDescription.value.trim() || null,
          position: addPosition,
          lane: addLane.value,
        }),
      });
      addModal.classList.add("hidden");
      loadBoard().catch(() => {});
    } catch (err) {
      alert(err.message);
    } finally {
      addSubmitBtn.disabled = false;
      addSubmitBtn.textContent = "Add Feature";
    }
  });

  // ---- Import ----
  const importFileInput = document.getElementById("import-file");
  const importConfirmModal = document.getElementById("import-confirm-modal");
  const importConfirmCount = document.getElementById("import-confirm-count");
  const importHeaderCheck = document.getElementById("import-header-check");
  let importRows = [];

  document.getElementById("import-btn").addEventListener("click", () => {
    importFileInput.value = "";
    importFileInput.click();
  });

  importFileInput.addEventListener("change", () => {
    const file = importFileInput.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const raw = parseCSV(reader.result);
      // Filter empty rows
      importRows = raw.filter((r) => r.trim().length > 0);
      if (importRows.length === 0) {
        alert("CSV is empty");
        return;
      }
      // Auto-detect header
      const first = importRows[0].toLowerCase();
      const headerKeywords = ["description", "title", "task", "idea", "name"];
      importHeaderCheck.checked = headerKeywords.some((kw) => first.includes(kw));
      importConfirmCount.textContent = `${importRows.length} rows detected`;
      importConfirmModal.classList.remove("hidden");
    };
    reader.readAsText(file);
  });

  // Import confirm modal close
  document.querySelector("#import-confirm-modal .modal-close").addEventListener("click", () => {
    importConfirmModal.classList.add("hidden");
  });
  importConfirmModal.addEventListener("click", (e) => {
    if (e.target === e.currentTarget) importConfirmModal.classList.add("hidden");
  });
  document.getElementById("import-cancel-btn").addEventListener("click", () => {
    importConfirmModal.classList.add("hidden");
  });

  // Import confirm
  document.getElementById("import-confirm-btn").addEventListener("click", async () => {
    let rows = importRows;
    if (importHeaderCheck.checked) rows = rows.slice(1);
    if (rows.length === 0) {
      alert("No data rows after skipping header");
      return;
    }
    importConfirmModal.classList.add("hidden");

    // Show progress banner
    const banner = document.getElementById("import-banner");
    const minutes = Math.max(1, Math.round((rows.length * 3) / 60));
    banner.textContent = `Importing ${rows.length} features (est. ${minutes} min)...`;
    banner.className = "import-banner";
    banner.classList.remove("hidden");
    stopAutoRefresh();

    try {
      const result = await api("/api/features/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: currentProjectId, rows: rows.map((d) => ({ description: d })) }),
      });

      banner.className = "import-banner success";
      if (result.skipped > 0) {
        banner.textContent = `✓ Imported ${result.imported} of ${result.imported + result.skipped} (${result.skipped} skipped)`;
        // Show skipped modal
        const skippedModal = document.getElementById("skipped-modal");
        document.getElementById("skipped-title").textContent = `${result.skipped} rows skipped`;
        const details = result.skippedRows.map((s) => `Row ${s.row}: ${s.reason}\n  "${s.description}"`).join("\n\n");
        document.getElementById("skipped-details").textContent = details;
        skippedModal.classList.remove("hidden");
      } else {
        banner.textContent = `✓ Imported ${result.imported} features`;
      }
      refreshBoardData().catch(() => {});
    } catch (err) {
      banner.className = "import-banner warning";
      banner.textContent = `Import failed: ${err.message}`;
    }
    startAutoRefresh();
  });

  // Skipped modal close + copy
  document.querySelector("#skipped-modal .modal-close").addEventListener("click", () => {
    document.getElementById("skipped-modal").classList.add("hidden");
  });
  document.getElementById("skipped-modal").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) e.currentTarget.classList.add("hidden");
  });
  document.getElementById("skipped-copy-btn").addEventListener("click", () => {
    const text = document.getElementById("skipped-details").textContent;
    navigator.clipboard.writeText(text).then(() => {
      document.getElementById("skipped-copy-btn").textContent = "Copied!";
      setTimeout(() => {
        document.getElementById("skipped-copy-btn").textContent = "Copy Details";
      }, 2000);
    });
  });

  // ---- Export ----
  const exportDropdown = document.getElementById("export-dropdown");
  const exportCheckboxes = document.getElementById("export-lane-checkboxes");
  const exportToggleAll = document.getElementById("export-toggle-all");

  // Populate lane checkboxes
  for (const lane of LANES) {
    const label = document.createElement("label");
    label.innerHTML = `<input type="checkbox" value="${lane}" checked /> ${LANE_LABELS[lane]}`;
    exportCheckboxes.appendChild(label);
  }

  document.getElementById("export-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    exportDropdown.classList.toggle("hidden");
  });

  // Close dropdown on outside click
  document.addEventListener("click", (e) => {
    if (!exportDropdown.contains(e.target) && e.target.id !== "export-btn") {
      exportDropdown.classList.add("hidden");
    }
  });

  // Toggle all
  exportToggleAll.addEventListener("click", () => {
    const boxes = exportCheckboxes.querySelectorAll("input[type=checkbox]");
    const allChecked = [...boxes].every((b) => b.checked);
    exportToggleAll.textContent = allChecked ? "Select All" : "Deselect All";
    boxes.forEach((b) => {
      b.checked = !allChecked;
    });
  });

  // Download
  document.getElementById("export-download-btn").addEventListener("click", async () => {
    const checked = [...exportCheckboxes.querySelectorAll("input:checked")].map((b) => b.value);
    if (checked.length === 0) {
      alert("Select at least one lane");
      return;
    }
    exportDropdown.classList.add("hidden");

    try {
      const res = await fetch(`/api/board/${currentProjectId}/export?lanes=${checked.join(",")}`, {
        headers: { Authorization: `Bearer ${window.__KANBAN_AUTH_TOKEN}` },
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Export failed: ${res.status}`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = res.headers.get("Content-Disposition")?.match(/filename="(.+?)"/)?.[1] || "kanban-export.csv";
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      alert(err.message);
    }
  });

  // Auto-detect project from URL query parameter
  const urlParams = new URLSearchParams(window.location.search);
  const projectParam = urlParams.get("project");
  if (projectParam) {
    currentProjectId = Number(projectParam);
    updateActionButtons();
  }

  setupScrollPause();
  loadProjects();
  startAutoRefresh();
});

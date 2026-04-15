/* global jQuery */
import { extension_settings } from '../../../extensions.js';

const MODULE_NAME = 'bb_floating_avatar_viewer';
const DEFAULT_SETTINGS = {
    interceptAvatarClicks: true,
    rememberPlacement: true,
    width: null,
    height: null,
    left: null,
    top: null,
};

const ROOT_ID = 'bbfav-root';
const AVATAR_SELECTORS = [
    '#user_avatar_block img',
    '#user_avatar_block .avatar',
    '.mesAvatar img',
    '.mesAvatar .avatar',
    '.avatar-container img',
    '.avatar-container .avatar',
    '.drawer-avatar img',
    '.drawer-avatar .avatar',
    '.group_member_avatar img',
    '.group_member_avatar .avatar',
    '.character-avatar img',
    '.character-avatar .avatar',
    '.mes .avatar img',
    '.mes .avatar',
    'img.avatar',
].join(', ');

const DESKTOP_BREAKPOINT = 768;
const HEADER_HEIGHT = 28;
const MIN_WINDOW_WIDTH_MOBILE = 120;
const MIN_WINDOW_WIDTH_DESKTOP = 160;
const PERSONA_HINT_SELECTORS = [
    '#user_avatar_block',
    '[id*="user_avatar"]',
    '[class*="user_avatar"]',
    '[class*="persona-avatar"]',
    '[class*="persona_avatar"]',
    '[class*="persona"]',
    '[data-persona]',
].join(', ');

let manager = null;
let clickBound = false;
let suppressAvatarClickUntil = 0;

function ensureSettings() {
    extension_settings[MODULE_NAME] = {
        ...DEFAULT_SETTINGS,
        ...(extension_settings[MODULE_NAME] || {}),
    };
    return extension_settings[MODULE_NAME];
}

function getContext() {
    try {
        return SillyTavern.getContext();
    } catch (error) {
        console.error('[BB FAV] Failed to get context', error);
        return null;
    }
}

function saveSettingsSoon() {
    getContext()?.saveSettingsDebounced?.();
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function sanitizeUrl(url = '') {
    return String(url || '').trim().replace(/^['"]|['"]$/g, '');
}

function extractUrlFromBackground(backgroundImage = '') {
    const match = String(backgroundImage || '').match(/url\((['"]?)(.*?)\1\)/i);
    return match?.[2] || '';
}

function normalizeAbsoluteUrl(url = '') {
    const safe = sanitizeUrl(url);
    if (!safe) return '';
    try {
        return new URL(safe, window.location.href).href;
    } catch {
        return safe;
    }
}

function parseSrcsetCandidates(srcset = '') {
    return String(srcset || '')
        .split(',')
        .map((chunk) => chunk.trim())
        .filter(Boolean)
        .map((entry) => {
            const [url, descriptor = ''] = entry.split(/\s+/, 2);
            const numeric = parseInt(descriptor, 10) || 0;
            return { url: normalizeAbsoluteUrl(url), descriptor, numeric };
        })
        .sort((left, right) => right.numeric - left.numeric)
        .map((entry) => entry.url);
}

function pushCandidate(list, url, source = 'unknown') {
    const safe = normalizeAbsoluteUrl(url);
    if (!safe) return;
    if (!list.some((entry) => entry.url === safe && entry.source === source)) {
        list.push({ url: safe, source });
    }
}

function scoreAvatarCandidate(candidate = { url: '', source: 'unknown' }) {
    const url = candidate.url || '';
    let score = 0;

    if (!url) return -Infinity;
    if (/^data:/i.test(url)) score -= 120;
    if (/^blob:/i.test(url)) score += 18;
    if (/user avatars|characters|persona|avatar/i.test(decodeURIComponent(url))) score += 12;
    if (/thumb|thumbnail|preview|small|crop|_min\b|size=/i.test(url)) score -= 30;
    if (/\.(png|webp|jpg|jpeg|gif)(\?|$)/i.test(url)) score += 6;
    score += Math.min(url.length / 40, 6);

    switch (candidate.source) {
        case 'context-original':
            score += 44;
            break;
        case 'original-derived':
            score += 34;
            break;
        case 'anchor-href':
        case 'data-full':
            score += 22;
            break;
        case 'img-current':
            score += 18;
            break;
        case 'img-srcset':
            score += 16;
            break;
        case 'img-src':
            score += 14;
            break;
        case 'background':
            score += 4;
            break;
        default:
            break;
    }

    return score;
}

function collectCandidateEntries(element) {
    if (!element) return [];
    const list = [];
    const image = element instanceof HTMLImageElement ? element : element.querySelector?.('img');
    const anchor = element.closest?.('a[href]') || image?.closest?.('a[href]') || null;

    [element, image, element.parentElement, anchor].filter(Boolean).forEach((node) => {
        if (!(node instanceof Element)) return;
        pushCandidate(list, node.getAttribute('data-fullsize'), 'data-full');
        pushCandidate(list, node.getAttribute('data-full-src'), 'data-full');
        pushCandidate(list, node.getAttribute('data-original'), 'data-full');
        pushCandidate(list, node.getAttribute('data-original-src'), 'data-full');
        pushCandidate(list, node.getAttribute('data-avatar-url'), 'data-full');
        pushCandidate(list, node.getAttribute('data-avatar'), 'data-full');
        pushCandidate(list, node.getAttribute('data-src'), 'img-src');
        pushCandidate(list, node.getAttribute('src'), 'img-src');
        pushCandidate(list, node.getAttribute('href'), node === anchor ? 'anchor-href' : 'img-src');
        pushCandidate(list, extractUrlFromBackground(node.style?.backgroundImage || ''), 'background');
        pushCandidate(list, extractUrlFromBackground(window.getComputedStyle(node).backgroundImage || ''), 'background');
    });

    if (image instanceof HTMLImageElement) {
        parseSrcsetCandidates(image.getAttribute('srcset') || '').forEach((url) => pushCandidate(list, url, 'img-srcset'));
        pushCandidate(list, image.currentSrc, 'img-current');
        pushCandidate(list, image.src, 'img-src');
    }

    if (anchor instanceof HTMLAnchorElement) {
        pushCandidate(list, anchor.href, 'anchor-href');
    }

    return list.sort((left, right) => scoreAvatarCandidate(right) - scoreAvatarCandidate(left));
}

function collectCandidateUrls(element) {
    return collectCandidateEntries(element).map((entry) => entry.url);
}

function extractAvatarUrl(element) {
    return collectCandidateUrls(element)[0] || '';
}

function decodeLoosePath(url = '') {
    try {
        return decodeURIComponent(String(url || ''));
    } catch {
        return String(url || '');
    }
}

function normalizeLoosePath(url = '') {
    return decodeLoosePath(url).replace(/\\/g, '/').toLowerCase();
}

function isLikelyPersonaUrl(url = '') {
    const safe = normalizeLoosePath(url);
    return /thumbnails\/persona|user avatars|\/user_avatar|type=persona|avatar_type=persona|persona_avatar/.test(safe);
}

function isLikelyCharacterUrl(url = '') {
    const safe = normalizeLoosePath(url);
    return /\/characters\/|thumbnails\/(avatar|character)|type=avatar|avatar_type=character/.test(safe);
}

function nodeHasHint(node, pattern) {
    const id = String(node?.id || '').toLowerCase();
    const cls = String(node?.className || '').toLowerCase();
    return pattern.test(`${id} ${cls}`);
}

function isPersonaAvatarElement(element) {
    if (!(element instanceof Element)) return false;
    if (element.closest(PERSONA_HINT_SELECTORS)) return true;

    let current = element;
    for (let depth = 0; current && depth < 7; depth += 1, current = current.parentElement) {
        if (nodeHasHint(current, /(user[_-]?avatar|persona)/i)) return true;
    }

    const urls = collectCandidateUrls(element);
    if (urls.some(isLikelyPersonaUrl)) return true;

    const nearestMessage = element.closest('.mes, .swipe, .group_member, .group_member_avatar');
    if (!nearestMessage && element.closest('.avatar, .avatar-container, [class*="avatar"]')) {
        const headerLike = element.closest('#right-nav-panel, #left-nav-panel, .drawer, .panel, .sidebar, body');
        if (headerLike) return true;
    }

    return false;
}

function getAvatarLabel(element) {
    const image = element instanceof HTMLImageElement ? element : element.querySelector?.('img');
    const alt = String(image?.alt || '').trim();
    if (alt) return alt;

    const title = String(element.getAttribute?.('title') || '').trim();
    if (title) return title;

    const nearestMessage = element.closest?.('.mes');
    const displayName = String(nearestMessage?.querySelector?.('.name_text, .mesName, .name')?.textContent || '').trim();
    if (displayName) return displayName;

    if (isPersonaAvatarElement(element)) return 'Persona';
    return 'Avatar';
}

function isViewerElement(element) {
    return !!element?.closest?.(`#${ROOT_ID}`);
}

function findAvatarElement(target) {
    if (!(target instanceof Element) || isViewerElement(target)) return null;
    const candidate = target.closest(AVATAR_SELECTORS);
    if (!candidate || isViewerElement(candidate)) return null;
    return candidate;
}

function suppressAvatarClicksFor(durationMs = 420) {
    suppressAvatarClickUntil = Date.now() + Math.max(durationMs, 0);
}

function shouldIgnoreAvatarClick(event, candidate) {
    if (!candidate) return true;
    if (Date.now() < suppressAvatarClickUntil) return true;

    const target = event.target;
    if (!(target instanceof Element)) return true;

    const interactiveAncestor = target.closest([
        'button',
        '[role="button"]',
        'input',
        'select',
        'textarea',
        'label',
        '.menu_button',
        '.right_menu_button',
        '.drawer-toggle',
        '.popup',
        '.modal',
        '.st-menu',
        '.menu',
        '.dropdown',
    ].join(', '));

    if (interactiveAncestor && !candidate.contains(interactiveAncestor)) {
        return true;
    }

    const visualHit = target.closest([
        'img',
        '.avatar',
        '.mesAvatar',
        '.avatar-container',
        '.drawer-avatar',
        '.group_member_avatar',
        '.character-avatar',
        '#user_avatar_block img',
        '#user_avatar_block .avatar',
    ].join(', '));

    if (!visualHit || (visualHit !== candidate && !candidate.contains(visualHit))) {
        return true;
    }

    if (interactiveAncestor && isPersonaAvatarElement(candidate)) {
        return true;
    }

    return false;
}

function uniqueUrls(urls = []) {
    const seen = new Set();
    const result = [];
    urls.forEach((url) => {
        const safe = normalizeAbsoluteUrl(url);
        if (!safe || seen.has(safe)) return;
        seen.add(safe);
        result.push(safe);
    });
    return result;
}

function buildFileNameVariants(fileName = '') {
    const safe = String(fileName || '').split(/[\\/]/).pop() || '';
    if (!safe) return [];
    const match = safe.match(/^(.*?)(?:\.([a-z0-9]+))?$/i);
    const stem = match?.[1] || safe;
    const ext = (match?.[2] || '').toLowerCase();
    const variants = [];
    if (ext) variants.push(`${stem}.${ext}`);
    ['png', 'webp', 'jpg', 'jpeg'].forEach((candidateExt) => {
        const next = `${stem}.${candidateExt}`;
        if (!variants.includes(next)) variants.push(next);
    });
    return variants;
}

function buildRootPathCandidates(fileName = '', kind = 'character') {
    const origin = window.location.origin;
    const root = kind === 'persona' ? '/User%20Avatars/' : '/characters/';
    return buildFileNameVariants(fileName).map((variant) => new URL(`${root}${encodeURIComponent(variant)}`, origin).href);
}

function extractFileNameFromUrl(url = '') {
    const safe = sanitizeUrl(url);
    if (!safe) return '';
    try {
        const parsed = new URL(safe, window.location.href);
        const params = parsed.searchParams;
        const queryFile = params.get('file') || params.get('avatar') || params.get('name') || params.get('img') || '';
        if (queryFile) return String(queryFile).split(/[\\/]/).pop() || '';
        const segment = decodeLoosePath(parsed.pathname).split('/').filter(Boolean).pop() || '';
        return segment;
    } catch {
        return decodeLoosePath(safe).split(/[\\/]/).filter(Boolean).pop() || '';
    }
}

function buildAssetSourceCandidates(rawSource = '', kind = 'character') {
    const safe = sanitizeUrl(rawSource);
    if (!safe) return [];

    const abs = normalizeAbsoluteUrl(safe);
    const normalized = normalizeLoosePath(abs);
    const fileName = extractFileNameFromUrl(abs);
    const candidates = [];

    const push = (url) => {
        const safeUrl = normalizeAbsoluteUrl(url);
        if (safeUrl) candidates.push(safeUrl);
    };

    if (fileName) {
        const rootCandidates = buildRootPathCandidates(fileName, kind);
        if (kind === 'persona') {
            rootCandidates.forEach(push);
            if (/user avatars/.test(normalized)) push(abs);
            else push(abs);
        } else {
            rootCandidates.forEach(push);
            push(abs);
        }
    } else {
        push(abs);
    }

    return uniqueUrls(candidates);
}

function getContextPersonaSourceCandidates() {
    const context = getContext();
    const raw = [
        context?.user_avatar,
        context?.userAvatar,
        context?.avatar,
        context?.persona_avatar,
        context?.selected_user_avatar,
        context?.selectedPersonaAvatar,
        context?.chatMetadata?.persona_avatar,
    ].filter(Boolean);

    const urls = [];
    raw.forEach((entry) => {
        buildAssetSourceCandidates(String(entry), 'persona').forEach((url) => urls.push(url));
    });
    return uniqueUrls(urls);
}

function buildViewerSourceCandidates(element, kind = 'character') {
    const urls = [];
    if (kind === 'persona') {
        getContextPersonaSourceCandidates().forEach((url) => urls.push(url));
    }

    collectCandidateEntries(element).forEach((entry) => {
        buildAssetSourceCandidates(entry.url, kind).forEach((url) => urls.push(url));
        if (kind === 'persona' && !isLikelyPersonaUrl(entry.url) && isLikelyCharacterUrl(entry.url)) {
            return;
        }
        urls.push(entry.url);
    });

    const deduped = uniqueUrls(urls);
    const scored = deduped.slice().sort((left, right) => {
        const leftScore = kind === 'persona'
            ? (isLikelyPersonaUrl(left) ? 40 : 0) + (!/thumb|thumbnail|preview|small|crop|_min\b|size=/i.test(left) ? 15 : -20)
            : (isLikelyCharacterUrl(left) ? 24 : 0) + (!/thumb|thumbnail|preview|small|crop|_min\b|size=/i.test(left) ? 12 : -12);
        const rightScore = kind === 'persona'
            ? (isLikelyPersonaUrl(right) ? 40 : 0) + (!/thumb|thumbnail|preview|small|crop|_min\b|size=/i.test(right) ? 15 : -20)
            : (isLikelyCharacterUrl(right) ? 24 : 0) + (!/thumb|thumbnail|preview|small|crop|_min\b|size=/i.test(right) ? 12 : -12);
        return rightScore - leftScore;
    });

    if (kind === 'persona') {
        console.log('[BB FAV] Persona source candidates', scored);
    }

    return scored;
}

class FloatingAvatarWindow {
    constructor(managerInstance, settings, options = {}) {
        this.manager = managerInstance;
        this.settings = settings;
        this.src = options.src || '';
        this.srcCandidates = Array.isArray(options.srcCandidates) ? options.srcCandidates.filter(Boolean) : [];
        this.kind = options.kind || 'character';
        this.label = options.label || 'Avatar';
        this.index = Number(options.index || 0);
        this.id = `bbfav-window-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

        this.root = null;
        this.imageWrap = null;
        this.image = null;
        this.closeButton = null;
        this.resizeHandle = null;

        this.dragState = null;
        this.resizeState = null;
        this.pinchState = null;
        this.isOpenFlag = false;
        this.imageAspectRatio = 2 / 3;
        this.naturalWidth = 512;
        this.naturalHeight = 768;
        this.boundWindowResize = () => this.ensureInViewport(false);
        this.pendingPersistTimer = 0;
        this.animationFrame = 0;
        this.animatedRect = null;
        this.targetRect = null;
        this.currentCandidateIndex = 0;
        this.touchDragState = null;
        this.touchResizeState = null;
    }

    init() {
        if (this.root) return;
        this.root = document.createElement('div');
        this.root.className = 'bbfav-window';
        this.root.dataset.viewerId = this.id;
        this.root.innerHTML = `
            <div class="bbfav-header" aria-label="Floating avatar header">
                <div class="bbfav-header-grip" aria-hidden="true"></div>
                <button type="button" class="bbfav-close" aria-label="Закрыть" title="Закрыть">
                    <i class="fa-solid fa-xmark"></i>
                </button>
            </div>
            <div class="bbfav-image-wrap">
                <img class="bbfav-image" alt="Avatar preview" draggable="false">
            </div>
            <div class="bbfav-resize-handle" aria-hidden="true"></div>
        `;
        this.manager.root.appendChild(this.root);
        this.imageWrap = this.root.querySelector('.bbfav-image-wrap');
        this.image = this.root.querySelector('.bbfav-image');
        this.closeButton = this.root.querySelector('.bbfav-close');
        this.resizeHandle = this.root.querySelector('.bbfav-resize-handle');
        this.bindEvents();
    }

    bindEvents() {
        const closeFromUi = (event) => {
            if (!this.isOpen()) return;
            event?.preventDefault?.();
            event?.stopPropagation?.();
            suppressAvatarClicksFor(260);
            this.close();
        };

        this.closeButton.addEventListener('click', closeFromUi);
        this.closeButton.addEventListener('pointerup', (event) => {
            if (event.pointerType !== 'touch') return;
            closeFromUi(event);
        });
        this.closeButton.addEventListener('touchend', closeFromUi, { passive: false });

        this.root.addEventListener('pointerdown', (event) => {
            if (!this.isOpen()) return;
            if (event.button !== 0) return;
            if (event.pointerType === 'touch') return;
            if (this.pinchState) return;
            if (event.target.closest('.bbfav-close')) return;
            if (event.target.closest('.bbfav-resize-handle')) return;
            const dragHandle = event.target.closest('.bbfav-header, .bbfav-header-grip');
            if (!dragHandle) return;
            this.manager.bringToFront(this);
            this.stopAnimatedResize();
            this.dragState = {
                pointerId: event.pointerId,
                startX: event.clientX,
                startY: event.clientY,
                originLeft: this.getWindowLeft(),
                originTop: this.getWindowTop(),
            };
            this.root.setPointerCapture?.(event.pointerId);
            this.root.classList.add('is-dragging');
            event.preventDefault();
        });

        this.root.addEventListener('pointermove', (event) => {
            if (this.pinchState) return;

            if (this.dragState && this.dragState.pointerId === event.pointerId) {
                this.placeWindow(
                    this.dragState.originLeft + (event.clientX - this.dragState.startX),
                    this.dragState.originTop + (event.clientY - this.dragState.startY),
                );
                event.preventDefault();
                return;
            }

            if (this.resizeState && this.resizeState.pointerId === event.pointerId) {
                this.resizeFromPointer(event.clientX);
                event.preventDefault();
            }
        });

        const releasePointer = (event) => {
            if (this.dragState && (!event || this.dragState.pointerId === event.pointerId)) {
                this.dragState = null;
                this.root.classList.remove('is-dragging');
                this.persistPlacement();
            }
            if (this.resizeState && (!event || this.resizeState.pointerId === event.pointerId)) {
                this.resizeState = null;
                this.root.classList.remove('is-resizing');
                this.persistPlacement();
            }
        };

        this.root.addEventListener('pointerup', releasePointer);
        this.root.addEventListener('pointercancel', releasePointer);
        this.root.addEventListener('lostpointercapture', releasePointer);

        this.resizeHandle.addEventListener('pointerdown', (event) => {
            if (!this.isOpen()) return;
            if (event.button !== 0) return;
            if (event.pointerType === 'touch') return;
            if (this.pinchState) return;
            this.manager.bringToFront(this);
            this.stopAnimatedResize();
            this.resizeState = {
                pointerId: event.pointerId,
                startX: event.clientX,
                startWidth: this.getWindowWidth(),
                startLeft: this.getWindowLeft(),
                startTop: this.getWindowTop(),
            };
            this.resizeHandle.setPointerCapture?.(event.pointerId);
            this.root.classList.add('is-resizing');
            event.preventDefault();
            event.stopPropagation();
        });

        this.root.addEventListener('wheel', (event) => {
            if (!this.isOpen()) return;
            this.manager.bringToFront(this);
            event.preventDefault();
            const multiplier = event.deltaY < 0 ? 1.18 : 1 / 1.18;
            this.scaleWindow(multiplier);
        }, { passive: false });

        this.root.addEventListener('touchstart', (event) => this.handleTouchStart(event), { passive: false });
        this.root.addEventListener('touchmove', (event) => this.handleTouchMove(event), { passive: false });
        this.root.addEventListener('touchend', (event) => this.handleTouchEnd(event), { passive: false });
        this.root.addEventListener('touchcancel', (event) => this.handleTouchEnd(event), { passive: false });

        window.addEventListener('resize', this.boundWindowResize);
    }

    destroy() {
        window.removeEventListener('resize', this.boundWindowResize);
        window.clearTimeout(this.pendingPersistTimer);
        this.stopAnimatedResize();
        this.root?.remove();
        this.root = null;
    }

    cancelPointerInteractions() {
        this.dragState = null;
        this.resizeState = null;
        this.touchResizeState = null;
        this.root?.classList.remove('is-dragging', 'is-resizing');
    }

    handleTouchStart(event) {
        if (!this.isOpen()) return;

        if (event.touches.length === 1) {
            const touch = event.touches[0];
            const closeButton = event.target.closest('.bbfav-close');
            const resizeHandle = event.target.closest('.bbfav-resize-handle');
            const dragHandle = event.target.closest('.bbfav-header, .bbfav-header-grip');

            if (closeButton) return;

            if (resizeHandle) {
                this.manager.bringToFront(this);
                this.stopAnimatedResize();
                this.cancelPointerInteractions();
                this.touchDragState = null;
                this.touchResizeState = {
                    startX: touch.clientX,
                    startY: touch.clientY,
                    startWidth: this.getWindowWidth(),
                    startLeft: this.getWindowLeft(),
                    startTop: this.getWindowTop(),
                };
                this.root?.classList.add('is-resizing');
                suppressAvatarClicksFor(260);
                event.preventDefault();
                return;
            }

            if (dragHandle) {
                this.manager.bringToFront(this);
                this.stopAnimatedResize();
                this.touchResizeState = null;
                this.touchDragState = {
                    startX: touch.clientX,
                    startY: touch.clientY,
                    originLeft: this.getWindowLeft(),
                    originTop: this.getWindowTop(),
                };
                this.root?.classList.add('is-dragging');
                suppressAvatarClicksFor(260);
                event.preventDefault();
            }
            return;
        }

        if (event.touches.length !== 2) return;
        this.manager.bringToFront(this);
        this.stopAnimatedResize();
        this.cancelPointerInteractions();
        this.touchDragState = null;
        this.touchResizeState = null;
        const [a, b] = event.touches;
        const startWidth = this.getWindowWidth();
        const startHeight = this.getWindowHeight();
        const startLeft = this.getWindowLeft();
        const startTop = this.getWindowTop();
        this.pinchState = {
            distance: Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY),
            width: startWidth,
            height: startHeight,
            left: startLeft,
            top: startTop,
            centerX: startLeft + (startWidth / 2),
            centerY: startTop + (startHeight / 2),
        };
        this.root?.classList.add('is-resizing');
        suppressAvatarClicksFor(420);
        event.preventDefault();
    }

    handleTouchMove(event) {
        if (!this.isOpen()) return;

        if (this.pinchState && event.touches.length === 2) {
            const [a, b] = event.touches;
            const nextDistance = Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY);
            const ratio = nextDistance / Math.max(this.pinchState.distance, 1);
            this.resizeWindow(this.pinchState.width * ratio, {
                anchorCenterX: this.pinchState.centerX,
                anchorCenterY: this.pinchState.centerY,
                originLeft: this.pinchState.left,
                originTop: this.pinchState.top,
                baseWidth: this.pinchState.width,
                baseHeight: this.pinchState.height,
            });
            suppressAvatarClicksFor(420);
            event.preventDefault();
            return;
        }

        if (this.touchResizeState && event.touches.length === 1) {
            const touch = event.touches[0];
            const deltaX = touch.clientX - this.touchResizeState.startX;
            const deltaY = touch.clientY - this.touchResizeState.startY;
            const delta = Math.max(deltaX, deltaY);
            this.resizeWindow(this.touchResizeState.startWidth + delta, {
                anchorEdge: 'bottom-right',
                originLeft: this.touchResizeState.startLeft,
                originTop: this.touchResizeState.startTop,
            });
            suppressAvatarClicksFor(260);
            event.preventDefault();
            return;
        }

        if (this.touchDragState && event.touches.length === 1) {
            const touch = event.touches[0];
            this.placeWindow(
                this.touchDragState.originLeft + (touch.clientX - this.touchDragState.startX),
                this.touchDragState.originTop + (touch.clientY - this.touchDragState.startY),
            );
            suppressAvatarClicksFor(260);
            event.preventDefault();
        }
    }

    handleTouchEnd(event) {
        if (this.pinchState && (!event || event.touches.length < 2)) {
            this.pinchState = null;
            this.root?.classList.remove('is-resizing');
            suppressAvatarClicksFor(420);
            this.persistPlacement();
        }

        if (this.touchResizeState && (!event || event.touches.length === 0)) {
            this.touchResizeState = null;
            if (!this.pinchState) this.root?.classList.remove('is-resizing');
            suppressAvatarClicksFor(260);
            this.persistPlacement();
        }

        if (this.touchDragState && (!event || event.touches.length === 0)) {
            this.touchDragState = null;
            this.root?.classList.remove('is-dragging');
            suppressAvatarClicksFor(260);
            this.persistPlacement();
        }
    }

    isOpen() {
        return this.isOpenFlag;
    }

    open() {
        const initialCandidates = uniqueUrls([...(this.srcCandidates || []), this.src]);
        if (!initialCandidates.length) return;
        this.srcCandidates = initialCandidates;
        this.init();
        this.isOpenFlag = true;
        this.root.classList.add('is-open');
        this.manager.bringToFront(this);
        this.currentCandidateIndex = 0;
        this.tryLoadCandidate(0);
    }

    tryLoadCandidate(index = 0) {
        if (!this.image) return;
        if (index >= this.srcCandidates.length) {
            console.warn('[BB FAV] Failed to load avatar candidates', this.kind, this.srcCandidates);
            return;
        }

        const candidate = this.srcCandidates[index];
        this.currentCandidateIndex = index;
        this.image.onload = () => {
            this.src = candidate;
            this.naturalWidth = this.image.naturalWidth || 512;
            this.naturalHeight = this.image.naturalHeight || 768;
            this.imageAspectRatio = Math.max(this.naturalWidth / Math.max(this.naturalHeight, 1), 0.1);
            this.applyInitialPlacement();
            console.log('[BB FAV] Loaded avatar', { kind: this.kind, src: candidate, size: `${this.naturalWidth}x${this.naturalHeight}` });
        };
        this.image.onerror = () => {
            this.tryLoadCandidate(index + 1);
        };
        this.image.src = candidate;
    }

    close() {
        this.isOpenFlag = false;
        this.manager.unregister(this);
    }

    stopAnimatedResize() {
        if (this.animationFrame) {
            cancelAnimationFrame(this.animationFrame);
            this.animationFrame = 0;
        }
        this.animatedRect = null;
        this.targetRect = null;
    }

    schedulePersistPlacement() {
        window.clearTimeout(this.pendingPersistTimer);
        this.pendingPersistTimer = window.setTimeout(() => this.persistPlacement(), 120);
    }

    getViewportPadding() {
        return window.innerWidth <= DESKTOP_BREAKPOINT ? 8 : 12;
    }

    getMinWindowWidth() {
        return window.innerWidth <= DESKTOP_BREAKPOINT ? MIN_WINDOW_WIDTH_MOBILE : MIN_WINDOW_WIDTH_DESKTOP;
    }

    getMaxWindowWidth() {
        return Math.max(this.getMinWindowWidth(), window.innerWidth - this.getViewportPadding() * 2);
    }

    getMaxWindowHeight() {
        return Math.max(140, window.innerHeight - this.getViewportPadding() * 2);
    }

    normalizeSizeByWidth(width) {
        const minWidth = this.getMinWindowWidth();
        const maxWidth = this.getMaxWindowWidth();
        const maxHeight = this.getMaxWindowHeight();
        const ratio = this.imageAspectRatio || (2 / 3);

        let nextWidth = clamp(width, minWidth, maxWidth);
        let nextHeight = Math.round(nextWidth / ratio) + HEADER_HEIGHT;

        if (nextHeight > maxHeight) {
            nextWidth = Math.min(nextWidth, Math.floor((maxHeight - HEADER_HEIGHT) * ratio));
            nextWidth = clamp(nextWidth, minWidth, maxWidth);
            nextHeight = Math.round(nextWidth / ratio) + HEADER_HEIGHT;
        }

        return {
            width: Math.round(nextWidth),
            height: Math.round(Math.min(nextHeight, maxHeight)),
        };
    }

    getDefaultSize() {
        const viewportWidth = window.innerWidth || 360;
        const viewportHeight = window.innerHeight || 640;
        const maxWidth = viewportWidth <= DESKTOP_BREAKPOINT ? viewportWidth * 0.78 : viewportWidth * 0.34;
        const maxHeight = viewportWidth <= DESKTOP_BREAKPOINT ? viewportHeight * 0.62 : viewportHeight * 0.76;
        const naturalWidth = this.naturalWidth || 512;
        const naturalHeight = this.naturalHeight || 768;

        let fitRatio = Math.min(
            maxWidth / naturalWidth,
            (maxHeight - HEADER_HEIGHT) / naturalHeight,
            1,
        );

        if (!Number.isFinite(fitRatio) || fitRatio <= 0) fitRatio = 1;
        return this.normalizeSizeByWidth(Math.round(naturalWidth * fitRatio));
    }

    getWindowWidth() {
        return this.root?.offsetWidth || parseFloat(this.root?.style.width) || 320;
    }

    getWindowHeight() {
        return this.root?.offsetHeight || parseFloat(this.root?.style.height) || 420;
    }

    getWindowLeft() {
        return parseFloat(this.root?.style.left) || 0;
    }

    getWindowTop() {
        return parseFloat(this.root?.style.top) || 0;
    }

    updateChromeScale() {
        if (!this.root) return;
        const scale = clamp(this.getWindowWidth() / 340, 0.72, 1.12);
        this.root.style.setProperty('--bbfav-ui-scale', scale.toFixed(3));
    }

    setRect(rect = {}) {
        if (!this.root) return;
        this.root.style.width = `${Math.round(rect.width)}px`;
        this.root.style.height = `${Math.round(rect.height)}px`;
        this.root.style.left = `${Math.round(rect.left)}px`;
        this.root.style.top = `${Math.round(rect.top)}px`;
        this.updateChromeScale();
    }

    applyInitialPlacement() {
        const rememberedWidth = Number(this.settings.width);
        const baseSize = Number.isFinite(rememberedWidth) && rememberedWidth > 0
            ? this.normalizeSizeByWidth(rememberedWidth)
            : this.getDefaultSize();

        const hasSavedLeft = Number.isFinite(Number(this.settings.left));
        const hasSavedTop = Number.isFinite(Number(this.settings.top));
        const cascadeOffset = Math.min(this.manager.windows.length * 18, 96);
        const startLeft = hasSavedLeft
            ? Number(this.settings.left) + cascadeOffset
            : Math.round((window.innerWidth - baseSize.width) / 2) + cascadeOffset;
        const startTop = hasSavedTop
            ? Number(this.settings.top) + cascadeOffset
            : Math.round((window.innerHeight - baseSize.height) / 2) + cascadeOffset;

        const rect = this.constrainRect({
            width: baseSize.width,
            height: baseSize.height,
            left: startLeft,
            top: startTop,
        });
        this.setRect(rect);
        this.persistPlacement();
    }

    constrainRect(rect = {}) {
        const padding = this.getViewportPadding();
        const width = rect.width ?? this.getWindowWidth();
        const height = rect.height ?? this.getWindowHeight();
        const maxLeft = Math.max(window.innerWidth - width - padding, padding);
        const maxTop = Math.max(window.innerHeight - height - padding, padding);
        return {
            width: Math.round(width),
            height: Math.round(height),
            left: clamp(rect.left ?? this.getWindowLeft(), padding, maxLeft),
            top: clamp(rect.top ?? this.getWindowTop(), padding, maxTop),
        };
    }

    placeWindow(left, top) {
        const rect = this.constrainRect({
            width: this.getWindowWidth(),
            height: this.getWindowHeight(),
            left,
            top,
        });
        this.setRect(rect);
    }

    ensureInViewport(forceCenter = false) {
        if (!this.root) return;
        this.stopAnimatedResize();
        const currentWidth = this.getWindowWidth();
        const size = this.normalizeSizeByWidth(currentWidth || this.getDefaultSize().width);
        const rect = forceCenter
            ? this.constrainRect({
                width: size.width,
                height: size.height,
                left: Math.round((window.innerWidth - size.width) / 2),
                top: Math.round((window.innerHeight - size.height) / 2),
            })
            : this.constrainRect({
                width: size.width,
                height: size.height,
                left: this.getWindowLeft(),
                top: this.getWindowTop(),
            });
        this.setRect(rect);
    }

    calculateResizedRect(nextWidth, options = {}) {
        const { width, height } = this.normalizeSizeByWidth(nextWidth);
        let left = options.originLeft ?? this.getWindowLeft();
        let top = options.originTop ?? this.getWindowTop();

        if (options.anchorEdge === 'bottom-right') {
            // keep top-left fixed
        } else if (Number.isFinite(options.anchorCenterX) && Number.isFinite(options.anchorCenterY)) {
            const oldWidth = Number.isFinite(options.baseWidth) ? options.baseWidth : this.getWindowWidth();
            const oldHeight = Number.isFinite(options.baseHeight) ? options.baseHeight : this.getWindowHeight();
            const localX = clamp((options.anchorCenterX - left) / Math.max(oldWidth, 1), 0, 1);
            const localY = clamp((options.anchorCenterY - top) / Math.max(oldHeight, 1), 0, 1);
            left = options.anchorCenterX - width * localX;
            top = options.anchorCenterY - height * localY;
        }

        return this.constrainRect({ width, height, left, top });
    }

    animateToRect(targetRect) {
        this.targetRect = this.constrainRect(targetRect);
        if (!this.animatedRect) {
            this.animatedRect = {
                width: this.getWindowWidth(),
                height: this.getWindowHeight(),
                left: this.getWindowLeft(),
                top: this.getWindowTop(),
            };
        }
        if (this.animationFrame) return;

        const step = () => {
            if (!this.targetRect || !this.animatedRect) {
                this.animationFrame = 0;
                return;
            }
            const easing = 0.28;
            this.animatedRect.width += (this.targetRect.width - this.animatedRect.width) * easing;
            this.animatedRect.height += (this.targetRect.height - this.animatedRect.height) * easing;
            this.animatedRect.left += (this.targetRect.left - this.animatedRect.left) * easing;
            this.animatedRect.top += (this.targetRect.top - this.animatedRect.top) * easing;
            this.setRect(this.animatedRect);

            const done = Math.abs(this.targetRect.width - this.animatedRect.width) < 0.6
                && Math.abs(this.targetRect.height - this.animatedRect.height) < 0.6
                && Math.abs(this.targetRect.left - this.animatedRect.left) < 0.6
                && Math.abs(this.targetRect.top - this.animatedRect.top) < 0.6;

            if (done) {
                this.setRect(this.targetRect);
                this.animatedRect = null;
                this.targetRect = null;
                this.animationFrame = 0;
                this.persistPlacement();
                return;
            }

            this.animationFrame = requestAnimationFrame(step);
        };

        this.animationFrame = requestAnimationFrame(step);
        this.schedulePersistPlacement();
    }

    scaleWindow(multiplier) {
        const baseRect = this.targetRect || {
            width: this.getWindowWidth(),
            height: this.getWindowHeight(),
            left: this.getWindowLeft(),
            top: this.getWindowTop(),
        };
        const centerX = baseRect.left + (baseRect.width / 2);
        const centerY = baseRect.top + (baseRect.height / 2);
        const targetRect = this.calculateResizedRect(baseRect.width * multiplier, {
            anchorCenterX: centerX,
            anchorCenterY: centerY,
            originLeft: baseRect.left,
            originTop: baseRect.top,
            baseWidth: baseRect.width,
            baseHeight: baseRect.height,
        });
        this.animateToRect(targetRect);
    }

    resizeFromPointer(clientX) {
        if (!this.resizeState) return;
        const deltaX = clientX - this.resizeState.startX;
        this.resizeWindow(this.resizeState.startWidth + deltaX, {
            anchorEdge: 'bottom-right',
            originLeft: this.resizeState.startLeft,
            originTop: this.resizeState.startTop,
        });
    }

    resizeWindow(nextWidth, options = {}) {
        this.stopAnimatedResize();
        const rect = this.calculateResizedRect(nextWidth, options);
        this.setRect(rect);
    }

    persistPlacement() {
        if (!this.root || !this.settings.rememberPlacement) return;
        this.settings.width = this.getWindowWidth();
        this.settings.height = this.getWindowHeight();
        this.settings.left = this.getWindowLeft();
        this.settings.top = this.getWindowTop();
        saveSettingsSoon();
    }
}

class FloatingAvatarManager {
    constructor(settings) {
        this.settings = settings;
        this.root = null;
        this.windows = [];
        this.nextZIndex = 1;
    }

    init() {
        if (this.root) return;
        this.root = document.createElement('div');
        this.root.id = ROOT_ID;
        document.body.appendChild(this.root);
        document.addEventListener('keydown', (event) => {
            if (event.key !== 'Escape' || this.windows.length === 0) return;
            const topWindow = [...this.windows].sort((a, b) => (Number(b.root?.style.zIndex || 0) - Number(a.root?.style.zIndex || 0)))[0];
            topWindow?.close();
        });
    }

    open(options = {}) {
        this.init();
        const windowInstance = new FloatingAvatarWindow(this, this.settings, {
            ...options,
            index: this.windows.length,
        });
        this.windows.push(windowInstance);
        windowInstance.open();
        return windowInstance;
    }

    bringToFront(windowInstance) {
        this.init();
        this.nextZIndex += 1;
        if (windowInstance?.root) {
            windowInstance.root.style.zIndex = String(this.nextZIndex);
        }
    }

    unregister(windowInstance) {
        this.windows = this.windows.filter((item) => item !== windowInstance);
        windowInstance?.destroy();
    }

    closeAll() {
        [...this.windows].forEach((item) => item.close());
    }
}

function getManager() {
    manager ??= new FloatingAvatarManager(ensureSettings());
    manager.init();
    return manager;
}

function openViewerFromElement(element) {
    const kind = isPersonaAvatarElement(element) ? 'persona' : 'character';
    const srcCandidates = buildViewerSourceCandidates(element, kind);
    const src = srcCandidates[0] || extractAvatarUrl(element);
    if (!src) return false;
    getManager().open({ src, srcCandidates, kind, label: getAvatarLabel(element) });
    return true;
}

function bindAvatarInterceptor() {
    if (clickBound) return;
    clickBound = true;

    document.addEventListener('click', (event) => {
        const settings = ensureSettings();
        if (!settings.interceptAvatarClicks) return;
        const candidate = findAvatarElement(event.target);
        if (!candidate) return;
        if (shouldIgnoreAvatarClick(event, candidate)) return;
        if (!extractAvatarUrl(candidate) && !isPersonaAvatarElement(candidate)) return;
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        openViewerFromElement(candidate);
    }, true);
}

function renderSettingsPanel() {
    if (document.getElementById('bbfav-settings-wrapper')) return;
    const settings = ensureSettings();
    const html = `
        <div id="bbfav-settings-wrapper" class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>🖼️ BB Floating Avatar Viewer</b>
                <div class="inline-drawer-icon fa-solid fa-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content" style="padding: 10px;">
                <label class="checkbox_label">
                    <input type="checkbox" id="bbfav-intercept-clicks" ${settings.interceptAvatarClicks ? 'checked' : ''}>
                    <span>Открывать аватарки в плавающих окнах</span>
                </label>
                <label class="checkbox_label" style="margin-top: 8px;">
                    <input type="checkbox" id="bbfav-remember-placement" ${settings.rememberPlacement ? 'checked' : ''}>
                    <span>Запоминать размер и последнюю позицию</span>
                </label>
                <div style="font-size: 12px; color: #94a3b8; margin-top: 8px; line-height: 1.45;">
                    Каждая аватарка открывается в своём окне. Перетаскивай окно куда удобно. На ПК крути колесо, чтобы менять размер. На телефоне используй жест пальцами или потяни за уголок справа снизу.
                </div>
            </div>
        </div>
    `;

    const target = document.querySelector('#extensions_settings2') || document.querySelector('#extensions_settings');
    if (!target) return;
    target.insertAdjacentHTML('beforeend', html);

    jQuery('#bbfav-intercept-clicks').on('change', function() {
        settings.interceptAvatarClicks = jQuery(this).is(':checked');
        saveSettingsSoon();
    });

    jQuery('#bbfav-remember-placement').on('change', function() {
        settings.rememberPlacement = jQuery(this).is(':checked');
        saveSettingsSoon();
    });
}

jQuery(() => {
    ensureSettings();
    bindAvatarInterceptor();
    renderSettingsPanel();
    getManager();
    window.bbFloatingAvatarViewer = {
        openFromElement: openViewerFromElement,
        openUrl: (src, label = 'Avatar') => getManager().open({ src, srcCandidates: [src], kind: 'character', label }),
        closeAll: () => getManager().closeAll(),
        manager: getManager(),
    };
});

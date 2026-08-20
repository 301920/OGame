// ==UserScript==
// @name         Ogame - Shurukn's Ultimate Expedtions
// @namespace    https://github.com/301920/OGame
// @version      0.1
// @description  Shurukn's Ultimate Expeditions for OGame (Gameforge). Auto-divide / EXPEDITION / Last Fleet, Fast Mode (Admiral + STANDARD galaxy preset), escort (Reaper/BC/Destroyer), origin lock, delayed start, delay between expeditions, recovery on return legs, continuous smart loop. OGLight + AntiGameReborn aware.
// @author       Shurukn
// @match        https://*.ogame.gameforge.com/game/*
// @icon         https://i.ibb.co/9H9MvwgS/image.png
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_notification
// @run-at       document-idle
// @downloadURL  https://github.com/301920/OGame/Shurukn Ultimate Expeditions.user.js
// @updateURL    https://github.com/301920/OGame/Shurukn Ultimate Exzpeditions.meta.js
// ==/UserScript==

(function () {
    "use strict";

    // ============================================================
    // VERSION / STORAGE
    // ============================================================

    const VERSION = "0.1";
    const STATE_KEY = "OGameShuruknUltimateExpeState_v0";
    const SETTINGS_KEY = "OGameShuruknUltimateExpeSettings_v0";

    // ============================================================
    // CONSTANTS
    // ============================================================

    const RETRY_COUNT = 3;
    const DOM_POLL_MS = 120;

    // 1 hour 45 minutes fallback when no return times are parseable
    const RECOVERY_DURATION_MS = 105 * 60 * 1000;
    const RECOVERY_REFRESH_MS = 14 * 60 * 1000; // 14m page refresh while waiting

    // Max delay sliders: 40 minutes
    const MAX_DELAY_MS = 40 * 60 * 1000;

    // Ship technology IDs
    const SHIP = {
        SMALL_CARGO: 202,
        LARGE_CARGO: 203,
        SPY_PROBE: 210,
        DESTROYER: 214,
        BATTLECRUISER: 215,
        REAPER: 218,
        PATHFINDER: 219
    };

    // Escort ship choices (1 per expedition in auto mode)
    const ESCORT_OPTIONS = {
        reaper: { id: SHIP.REAPER, key: "reaper", labelEn: "Reaper", labelFr: "Faucheur" },
        battlecruiser: { id: SHIP.BATTLECRUISER, key: "battlecruiser", labelEn: "Battlecruiser", labelFr: "Croiseur de bataille" },
        destroyer: { id: SHIP.DESTROYER, key: "destroyer", labelEn: "Destroyer", labelFr: "Destructeur" }
    };

    const AGO_ROUTINE_ID = "ago_routine_7";
    const FAST_PRESET_NAME = "STANDARD";

    // ============================================================
    // DEFAULT SETTINGS
    // ============================================================

    const DEFAULT_SETTINGS = {
        // "auto" = divide cargos/pathfinders by free expo slots +1 probe +1 escort
        // "expedition" = AGO/vanilla standard fleet preset named EXPEDITION
        // "last" = last fleet template
        fleetMode: "auto",

        // Fast mode: Galaxy tab → expeditionFleetTemplateSelect "STANDARD" → #sendExpeditionFleetTemplateFleet
        // Only effective when Admiral officer is active
        fastMode: false,

        // Escort ship sent 1 per expedition (auto mode only)
        // "reaper" | "battlecruiser" | "destroyer"
        escortShip: "destroyer",

        language: "en",
        theme: "dark",

        panelVisible: true,
        panelMinimized: false,
        panelPosition: null,

        humanize: true,
        notifications: true,

        // Classic path timings (ms)
        delayRefresh: 3500,
        delayDropdown: 2000,
        delaySelect: 2000,
        delayContinue: 2000,
        delaySend: 1500,
        retryDelay: 3500,

        // Delayed start: only applies once when pressing PLAY from STOPPED (0 … 40 min)
        delayStartMs: 0,

        // Delay between successive expeditions (0 … 40 min) — applies after each successful send
        delayBetweenExpeditionsMs: 0,

        // Origin lock — moon/planet from which expeditions are launched
        lockGalaxy: 6,
        lockSystem: 6,
        lockPosition: 15,
        lockType: "moon", // "moon" | "planet"

        // Minimum ships that must remain free on planet (safety)
        reserveSmallCargo: 0,
        reserveLargeCargo: 0,
        reservePathfinder: 0
    };

    let settings = Object.assign({}, DEFAULT_SETTINGS, GM_getValue(SETTINGS_KEY, {}));
    // Migrate legacy fleetMode value
    if (settings.fleetMode === "standard") settings.fleetMode = "expedition";
    // Ensure escortShip is valid
    if (!ESCORT_OPTIONS[settings.escortShip]) settings.escortShip = "battlecruiser";
    // Clamp delays
    settings.delayStartMs = Math.max(0, Math.min(MAX_DELAY_MS, settings.delayStartMs || 0));
    settings.delayBetweenExpeditionsMs = Math.max(0, Math.min(MAX_DELAY_MS, settings.delayBetweenExpeditionsMs || 0));

    // ============================================================
    // STEP DEFINITIONS
    // ============================================================

    const STEP_DEFINITIONS = [
        { id: "navigate", en: "Navigate / Origin lock", fr: "Navigation / Verrouillage origine" },
        { id: "parse", en: "Parse slots & ships", fr: "Analyse slots & vaisseaux" },
        { id: "ago", en: "AGO Expedition routine", fr: "Routine AGO Expédition" },
        { id: "ships", en: "Select ships / preset", fr: "Sélection vaisseaux / préréglage" },
        { id: "continue", en: "Continue → coords screen", fr: "Continuer → écran coords" },
        { id: "send", en: "Send fleet (#dispatchFleet)", fr: "Envoyer (#dispatchFleet)" },
        { id: "verify", en: "Verify send + slots", fr: "Vérifier envoi + slots" }
    ];

    // ============================================================
    // DEFAULT STATE
    // ============================================================

    const DEFAULT_STATE = {
        active: false,
        paused: false,
        recovery: false,
        recoveryStartedAt: 0,
        recoveryUntil: 0, // absolute timestamp when recovery ends (from event list or fallback)
        recoveryReason: "",
        lastError: "",
        lastErrorType: "",
        cycle: 0,
        totalSent: 0,
        lockedPlanetId: null,
        lockedType: null,
        lockedCoords: null,
        startedAt: 0,
        currentStep: 0,
        stepStates: {},
        stepRetries: {},
        lastStepSuccessAt: 0,
        previousRequested: false,
        lastFleetComposition: null, // { smallCargo, largeCargo, pathfinder, spyProbe, escortShip, escortQty, ... }
        lastSlots: null, // { fleetUsed, fleetTotal, expoUsed, expoTotal }
        // Delayed start: only set when PLAY is pressed from fully stopped state
        pendingStartUntil: 0
    };

    let state = Object.assign({}, DEFAULT_STATE, GM_getValue(STATE_KEY, {}));

    // ============================================================
    // RUNTIME
    // ============================================================

    let sequenceRunning = false;
    let recoveryRunning = false;
    let currentStage = "Startup";
    let panel = null;
    let statusElement = null;
    let logElement = null;
    let stepsElement = null;
    let countdownElement = null;
    let infoElement = null;
    let countdownTimer = null;

    // ============================================================
    // TRANSLATION
    // ============================================================

    function t(en, fr) {
        return settings.language === "fr" ? fr : en;
    }

    function stepName(step) {
        return step ? t(step.en, step.fr) : "";
    }

    // ============================================================
    // STATE HELPERS
    // ============================================================

    function normalizeState() {
        if (!state.stepStates || typeof state.stepStates !== "object") state.stepStates = {};
        if (!state.stepRetries || typeof state.stepRetries !== "object") state.stepRetries = {};

        STEP_DEFINITIONS.forEach(step => {
            if (!state.stepStates[step.id]) state.stepStates[step.id] = "waiting";
            if (typeof state.stepRetries[step.id] !== "number") state.stepRetries[step.id] = 0;
        });

            if (typeof state.currentStep !== "number" || state.currentStep < 0 || state.currentStep >= STEP_DEFINITIONS.length) {
                state.currentStep = 0;
            }
    }

    normalizeState();

    function saveState() {
        GM_setValue(STATE_KEY, state);
        updatePanel();
    }

    function saveSettings() {
        GM_setValue(SETTINGS_KEY, settings);
        updatePanel();
    }

    // ============================================================
    // UTILITIES
    // ============================================================

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async function humanizedSleep(baseMs) {
        if (!settings.humanize) {
            await sleep(baseMs);
            return;
        }
        const jitterRange = baseMs * 0.15;
        const jitter = Math.floor(Math.random() * (jitterRange * 2 + 1)) - jitterRange;
        await sleep(Math.max(250, Math.round(baseMs + jitter)));
    }

    function now() {
        return new Date().toLocaleTimeString();
    }

    function log(message, level = "INFO") {
        const line = `[${now()}] [${level}] ${message}`;
        if (level === "ERROR") console.error(line);
        else if (level === "WARN") console.warn(line);
        else console.log(line);
        updatePanel(line);
    }

    function parseNumber(text) {
        if (text == null) return 0;
        const cleaned = String(text).replace(/[^\d]/g, "");
        return cleaned ? parseInt(cleaned, 10) : 0;
    }

    // ============================================================
    // NOTIFICATIONS
    // ============================================================

    function playAlertSound() {
        if (!settings.notifications) return;
        try {
            const AudioCtx = window.AudioContext || window.webkitAudioContext;
            if (!AudioCtx) return;
            const ctx = new AudioCtx();
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.type = "sine";
            osc.frequency.setValueAtTime(440, ctx.currentTime);
            osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.1);
            gain.gain.setValueAtTime(0.1, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
            osc.start();
            osc.stop(ctx.currentTime + 0.5);
        } catch (e) {
            console.warn("Audio notification failed", e);
        }
    }

    function notifyUser(title, text) {
        if (!settings.notifications) return;
        try {
            GM_notification({ title, text, timeout: 5000, silent: false });
        } catch (e) {
            console.warn("GM_notification failed", e);
        }
        playAlertSound();
    }

    // ============================================================
    // DOM HELPERS
    // ============================================================

    function isVisible(el) {
        if (!el || !el.isConnected) return false;
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    }

    function normalizedText(el) {
        return (el?.textContent || "").replace(/\s+/g, " ").trim().toUpperCase();
    }

    async function waitForCondition(condition, timeout, description) {
        const started = Date.now();
        while (Date.now() - started < timeout) {
            if (!state.active) throw new Error("AUTOMATION_STOPPED");
            await waitWhilePaused();
            try {
                const result = condition();
                if (result) return result;
            } catch (_) {}
            await sleep(DOM_POLL_MS);
        }
        throw new Error(`TIMEOUT: ${description} not found within ${timeout}ms.`);
    }

    // ============================================================
    // PAUSE / PLAY / PREVIOUS / RESET
    // ============================================================

    async function waitWhilePaused() {
        while (state.active && state.paused && !state.recovery) {
            currentStage = t("PAUSED", "EN PAUSE");
            updatePanel();
            await sleep(250);
        }
    }

    function pauseAutomation() {
        if (!state.active) return;
        state.paused = true;
        saveState();
        log(t("AUTOMATION PAUSED.", "AUTOMATISATION EN PAUSE."), "WARN");
    }

    function playAutomation() {
        if (state.recovery) {
            log(t("PLAY is unavailable during recovery.", "LECTURE indisponible pendant la récupération."), "WARN");
            return;
        }

        const wasStopped = !state.active;

        if (!state.active) {
            state.active = true;
            state.paused = false;
            state.startedAt = state.startedAt || Date.now();

            // Delayed start applies ONLY when starting from fully stopped
            const startDelay = Math.max(0, Math.min(MAX_DELAY_MS, settings.delayStartMs || 0));
            if (startDelay > 0) {
                state.pendingStartUntil = Date.now() + startDelay;
                saveState();
                log(
                    t(
                        `AUTOMATION START DELAYED by ${formatDuration(startDelay)}.`,
                        `DÉMARRAGE RETARDÉ de ${formatDuration(startDelay)}.`
                    )
                );
                runDelayedStart();
                return;
            }

            state.pendingStartUntil = 0;
            saveState();
            log(t("AUTOMATION STARTED.", "AUTOMATISATION DÉMARRÉE."));
        } else {
            state.paused = false;
            state.pendingStartUntil = 0;
            saveState();
            log(t("AUTOMATION RESUMED.", "AUTOMATISATION REPRISE."));
        }

        // If fast mode requested but Admiral offline, warn once
        if (settings.fastMode && !isAdmiralActive()) {
            log(
                t(
                    "Fast Mode requires active Admiral — falling back to classic path.",
                    "Mode Rapide nécessite l'Amiral actif — retour au parcours classique."
                ),
                "WARN"
            );
        }

        executeFleetSequence();
    }

    let delayedStartRunning = false;
    async function runDelayedStart() {
        if (delayedStartRunning) return;
        delayedStartRunning = true;
        try {
            while (state.active && state.pendingStartUntil && Date.now() < state.pendingStartUntil) {
                if (state.paused) {
                    await sleep(250);
                    continue;
                }
                const remaining = state.pendingStartUntil - Date.now();
                currentStage = t(
                    `Start delay: ${formatDuration(remaining)}`,
                    `Délai de démarrage : ${formatDuration(remaining)}`
                );
                updatePanel();
                await sleep(Math.min(1000, Math.max(200, remaining)));
            }
            if (!state.active) return;
            state.pendingStartUntil = 0;
            saveState();
            log(t("Start delay complete — launching expeditions.", "Délai de démarrage terminé — lancement des expéditions."));
            executeFleetSequence();
        } finally {
            delayedStartRunning = false;
        }
    }

    function previousStep() {
        if (state.recovery) {
            log(t("Previous step disabled during recovery.", "Étape précédente désactivée pendant la récupération."), "WARN");
            return;
        }
        const previous = Math.max(0, state.currentStep - 1);
        state.currentStep = previous;
        const step = STEP_DEFINITIONS[previous];
        if (step) {
            state.stepStates[step.id] = "waiting";
            state.stepRetries[step.id] = 0;
        }
        state.previousRequested = true;
        state.active = true;
        state.paused = false;
        saveState();
        log(t(`Returning to step ${previous + 1}: ${stepName(step)}.`, `Retour à l'étape ${previous + 1} : ${stepName(step)}.`), "WARN");
        executeFleetSequence();
    }

    function resetAutomation() {
        stopCountdown();
        state = Object.assign({}, DEFAULT_STATE);
        normalizeState();
        saveState();
        log(t("STATE RESET.", "ÉTAT RÉINITIALISÉ."), "WARN");
    }

    // ============================================================
    // PAGE / PLANET / MOON  (OGLight + AGO aware)
    // ============================================================

    function getMeta(name) {
        return document.querySelector(`meta[name="${name}"]`)?.getAttribute("content") || null;
    }

    function isFleetDispatchPage() {
        try {
            const component = new URLSearchParams(window.location.search).get("component");
            if (component === "fleetdispatch") return true;
            if (document.querySelector("#fleetdispatchcomponent")) return true;
            if (document.querySelector("#fleet1")) return true;
            // OGLight / AGO often leave fleetDispatcher on the page
            if (window.fleetDispatcher && window.fleetDispatcher.currentPage === "fleet1") return true;
            return false;
        } catch {
            return false;
        }
    }

    function isFleetMenuSelected() {
        const fleetBtn =
        document.querySelector('#menuTable a.menubutton[href*="component=fleetdispatch"]') ||
        document.querySelector('a.menubutton[href*="fleetdispatch"]');
        return !!(fleetBtn && fleetBtn.classList.contains("selected"));
    }

    function goToFleetDispatch(cpId) {
        const base = "?page=ingame&component=fleetdispatch";
        const url = cpId ? `${base}&cp=${cpId}` : base;
        // Prefer clicking the menu button so OGLight/AGO hooks run
        const fleetBtn =
        document.querySelector('#menuTable a.menubutton[href*="component=fleetdispatch"]') ||
        document.querySelector('a.menubutton[href*="fleetdispatch"]');
        if (fleetBtn && !cpId) {
            fleetBtn.click();
            return;
        }
        window.location.href = url;
    }

    /**
     * Admiral officer active when the icon has class "on"
     * e.g. <a class="tooltipHTML on admiral ...">
     */
    function isAdmiralActive() {
        const selectors = [
            "a.admiral.on",
            "a.tooltipHTML.admiral.on",
            "#officers a.admiral.on",
            "a[class*='admiral'].on",
            ".admiral.on"
        ];
        for (const sel of selectors) {
            const el = document.querySelector(sel);
            if (el && el.isConnected) return true;
        }
        // Fallback: any admiral link whose tooltip mentions active days / "Still active"
        const candidates = document.querySelectorAll("a.admiral, a[class*='admiral']");
        for (const el of candidates) {
            const tip = (el.getAttribute("data-tooltip-title") || el.title || "").toLowerCase();
            if (el.classList.contains("on")) return true;
            if (tip.includes("still active") || tip.includes("encore actif") || tip.includes("noch aktiv")) {
                return true;
            }
        }
        return false;
    }

    function isGalaxyPage() {
        try {
            const component = new URLSearchParams(window.location.search).get("component");
            if (component === "galaxy") return true;
            if (document.querySelector("#galaxycomponent, #galaxyContent, #galaxytable, .galaxy_icons")) return true;
            return false;
        } catch {
            return false;
        }
    }

    function goToGalaxy() {
        const btn =
            document.querySelector('#menuTable a.menubutton[href*="component=galaxy"]') ||
            document.querySelector('a.menubutton[href*="component=galaxy"]') ||
            document.querySelector('a.menubutton[href*="galaxy"]');
        if (btn) {
            btn.click();
            return;
        }
        window.location.href = "?page=ingame&component=galaxy";
    }

    function shouldUseFastMode() {
        return !!(settings.fastMode && isAdmiralActive());
    }

    /**
     * Returns { id, type, galaxy, system, position, name } of the currently selected body.
     */
    function getCurrentBody() {
        const id = getMeta("ogame-planet-id");
        const type = getMeta("ogame-planet-type"); // "planet" | "moon"
        const name = getMeta("ogame-planet-name");
        const coords = getMeta("ogame-planet-coordinates"); // "4:20:15"
        let galaxy = 0, system = 0, position = 0;
        if (coords) {
            const parts = coords.split(":").map(n => parseInt(n, 10));
            galaxy = parts[0] || 0;
            system = parts[1] || 0;
            position = parts[2] || 0;
        }
        // fleetDispatcher may expose more accurate data
        try {
            const cp = window.fleetDispatcher?.currentPlanet;
            if (cp) {
                return {
                    id: String(cp.id || id || ""),
 type: cp.type === 3 || type === "moon" ? "moon" : "planet",
 galaxy: cp.galaxy || galaxy,
 system: cp.system || system,
 position: cp.position || position,
 name: cp.name || name || ""
                };
            }
        } catch (_) {}
        return {
            id: id ? String(id) : null,
 type: type || "planet",
 galaxy,
 system,
 position,
 name: name || ""
        };
    }

    function getPlanetId() {
        const body = getCurrentBody();
        return body.id || null;
    }

    /**
     * Find the planet-list entry matching coords, preferring moon when lockType is "moon".
     */
    function findPlanetListEntry(galaxy, system, position, preferMoon) {
        const planets = document.querySelectorAll("#planetList .smallplanet");
        for (const el of planets) {
            const coordEl =
            el.querySelector(".planet-koords") ||
            el.querySelector(".coords") ||
            el.querySelector("[class*='coord']");
            const text = (coordEl?.textContent || el.textContent || "").replace(/\s+/g, "");
            const match = text.match(/\[?(\d+):(\d+):(\d+)\]?/);
            if (!match) continue;
            if (
                parseInt(match[1], 10) !== galaxy ||
                parseInt(match[2], 10) !== system ||
                parseInt(match[3], 10) !== position
            ) {
                continue;
            }

            // Moon link patterns used by vanilla / AGO / OGLight
            const moonLink =
            el.querySelector("a.moonlink") ||
            el.querySelector("a[href*='cp='][title*='oon']") ||
            el.querySelector("a[href*='cp='] .icon-moon") ||
            el.querySelector(".moon a") ||
            el.querySelector("a[href*='&cp='][href*='moon']") ||
            el.querySelector("a.tooltip[href*='cp=']:not(.planetlink)");

            const planetLink =
            el.querySelector("a.planetlink") ||
            el.querySelector("a[href*='cp=']") ||
            el;

            if (preferMoon && moonLink) {
                return { element: el, link: moonLink, kind: "moon" };
            }
            return { element: el, link: planetLink, kind: "planet" };
        }
        return null;
    }

    function coordsMatchSettings(body) {
        if (!settings.lockGalaxy && !settings.lockSystem && !settings.lockPosition) return true;
        if (!body) return false;
        if (settings.lockGalaxy && body.galaxy !== settings.lockGalaxy) return false;
        if (settings.lockSystem && body.system !== settings.lockSystem) return false;
        if (settings.lockPosition && body.position !== settings.lockPosition) return false;
        if (settings.lockType === "moon" && body.type !== "moon") return false;
        if (settings.lockType === "planet" && body.type !== "planet") return false;
        return true;
    }

    function lockPlanetIfNecessary() {
        const body = getCurrentBody();
        if (!body.id) return;

        // Persist lock from settings coords if not already locked
        if (!state.lockedPlanetId) {
            state.lockedPlanetId = body.id;
            state.lockedType = body.type;
            state.lockedCoords = `${body.galaxy}:${body.system}:${body.position}`;
            saveState();
            log(
                t(
                    `Origin locked: ${body.type} [${body.galaxy}:${body.system}:${body.position}] id=${body.id}`,
                  `Origine verrouillée : ${body.type} [${body.galaxy}:${body.system}:${body.position}] id=${body.id}`
                )
            );
        }
    }

    /**
     * Ensures we are on the configured origin (moon at 4:20:15 by default).
     * Returns true if a navigation click was performed (caller should wait).
     */
    function enforcePlanetLock() {
        const body = getCurrentBody();

        // If settings specify coords, prefer those over stored id
        const wantGalaxy = settings.lockGalaxy || 0;
        const wantSystem = settings.lockSystem || 0;
        const wantPosition = settings.lockPosition || 0;
        const wantMoon = settings.lockType === "moon";

        if (wantGalaxy && wantSystem && wantPosition) {
            if (coordsMatchSettings(body)) {
                // Already on the right body
                if (!state.lockedPlanetId && body.id) {
                    state.lockedPlanetId = body.id;
                    state.lockedType = body.type;
                    state.lockedCoords = `${body.galaxy}:${body.system}:${body.position}`;
                    saveState();
                }
                return false;
            }

            log(
                t(
                    `Switching to locked origin [${wantGalaxy}:${wantSystem}:${wantPosition}] (${wantMoon ? "moon" : "planet"}).`,
                  `Basculement vers l'origine verrouillée [${wantGalaxy}:${wantSystem}:${wantPosition}] (${wantMoon ? "lune" : "planète"}).`
                ),
                "WARN"
            );

            const entry = findPlanetListEntry(wantGalaxy, wantSystem, wantPosition, wantMoon);
            if (entry && entry.link) {
                entry.link.click();
                return true;
            }

            // Fallback: try locked id
            if (state.lockedPlanetId) {
                const link =
                document.querySelector(`#planetList a[href*="cp=${state.lockedPlanetId}"]`) ||
                document.querySelector(`#planetList a[data-planet-id="${state.lockedPlanetId}"]`) ||
                document.querySelector(`#planetList a[data-id="${state.lockedPlanetId}"]`);
                if (link) {
                    link.click();
                    return true;
                }
            }

            log(
                t(
                    "Could not find locked origin in planet list.",
                  "Origine verrouillée introuvable dans la liste des planètes."
                ),
                "ERROR"
            );
            return false;
        }

        // No coords in settings — fall back to id lock
        if (!state.lockedPlanetId) return false;
        if (body.id && body.id === state.lockedPlanetId) return false;

        log(
            t(
                `Auto-routing to locked id ${state.lockedPlanetId}.`,
              `Routage automatique vers l'id verrouillé ${state.lockedPlanetId}.`
            ),
            "WARN"
        );
        const link =
        document.querySelector(`#planetList a[href*="cp=${state.lockedPlanetId}"]`) ||
        document.querySelector(`#planetList a[data-planet-id="${state.lockedPlanetId}"]`) ||
        document.querySelector(`#planetList a[data-id="${state.lockedPlanetId}"]`);
        if (link) {
            link.click();
            return true;
        }
        return false;
    }

    /**
     * Wait until window.fleetDispatcher is available (OGLight / vanilla).
     */
    async function waitForFleetDispatcher(timeout = 12000) {
        try {
            await waitForCondition(
                () => window.fleetDispatcher && Array.isArray(window.fleetDispatcher.shipsOnPlanet),
                                   timeout,
                                   "fleetDispatcher"
            );
            return true;
        } catch {
            return false;
        }
    }

    // ============================================================
    // SLOT PARSING (AGO + fallback)
    // ============================================================

    /**
     * Parses "Flottes: 4/17 Expés: 1/6" style text from AGO movement link
     * or any element containing similar patterns.
     */
    function parseSlotsFromText(text) {
        if (!text) return null;
        const normalized = text.replace(/\s+/g, " ");

        // French / English variants
        // Flottes: 4/17  |  Fleets: 4/17
        // Expés: 1/6     |  Exp: 1/6  |  Expeditions: 1/6
        const fleetMatch = normalized.match(/(?:Flottes?|Fleets?)\s*:\s*(\d+)\s*\/\s*(\d+)/i);
        const expoMatch = normalized.match(/(?:Expés?|Expes?|Expeditions?|Expo)\s*:\s*(\d+)\s*\/\s*(\d+)/i);

        if (!fleetMatch && !expoMatch) return null;

        return {
            fleetUsed: fleetMatch ? parseInt(fleetMatch[1], 10) : 0,
 fleetTotal: fleetMatch ? parseInt(fleetMatch[2], 10) : 0,
 expoUsed: expoMatch ? parseInt(expoMatch[1], 10) : 0,
 expoTotal: expoMatch ? parseInt(expoMatch[2], 10) : 0
        };
    }

    function getSlots() {
        // 1. AGO movement link (most reliable when AGO is present)
        const agoMovement =
        document.querySelector("a.ago_movement") ||
        document.querySelector('a[href*="component=movement"]');

        if (agoMovement) {
            const slots = parseSlotsFromText(agoMovement.textContent);
            if (slots) return slots;
        }

        // 2. Any element that looks like slot counters
        const candidates = document.querySelectorAll(
            ".ago_movement, #slots, .fleetSlots, .expeditionSlots, [class*='slot'], [class*='expo']"
        );
        for (const el of candidates) {
            const slots = parseSlotsFromText(el.textContent);
            if (slots && (slots.expoTotal > 0 || slots.fleetTotal > 0)) return slots;
        }

        // 3. Body-wide regex fallback
        const bodyText = document.body?.innerText || "";
        return parseSlotsFromText(bodyText);
    }

    function freeExpoSlots(slots) {
        if (!slots || !slots.expoTotal) return 0;
        return Math.max(0, slots.expoTotal - slots.expoUsed);
    }

    function freeFleetSlots(slots) {
        if (!slots || !slots.fleetTotal) return 0;
        return Math.max(0, slots.fleetTotal - slots.fleetUsed);
    }

    // ============================================================
    // SHIP PARSING
    // ============================================================

    function getShipCountOnPlanet(techId) {
        // Prefer fleetDispatcher (vanilla + OGLight)
        try {
            const fd = window.fleetDispatcher;
            if (fd) {
                // shipsOnPlanet can be array or map depending on version
                if (Array.isArray(fd.shipsOnPlanet)) {
                    const entry = fd.shipsOnPlanet.find(s => s && s.id === techId);
                    if (entry) return parseNumber(entry.number);
                } else if (fd.shipsOnPlanet?.[techId]) {
                    return parseNumber(fd.shipsOnPlanet[techId].number);
                }
                if (typeof fd.getNumberOfShipsOnPlanet === "function") {
                    return parseNumber(fd.getNumberOfShipsOnPlanet(techId));
                }
            }
        } catch (_) {}

        // data-technology list items (OGLight / vanilla fleet1)
        const li =
        document.querySelector(`li[data-technology="${techId}"]`) ||
        document.querySelector(`.technology[data-technology="${techId}"]`);
        if (li) {
            const amount =
            li.querySelector(".amount") ||
            li.querySelector("[data-value]") ||
            li.querySelector("span span") ||
            li;
            const n = parseNumber(amount.getAttribute("data-value") || amount.textContent);
            if (n > 0) return n;
        }

        // Classic input names
        const input =
        document.querySelector(`input[name="am${techId}"]`) ||
        document.querySelector(`#ship_${techId}`) ||
        document.querySelector(`li[data-technology="${techId}"] input`) ||
        document.querySelector(`.technology[data-technology="${techId}"] input`);
        if (input) {
            const max = parseNumber(input.getAttribute("data-max") || input.getAttribute("max"));
            if (max > 0) return max;
            const parent = input.closest("li, .ship, tr, .row, .technology");
            if (parent) {
                const n = parseNumber(parent.textContent);
                if (n > 0) return n;
            }
        }

        return 0;
    }

    function getEscortConfig() {
        const key = (settings.escortShip || "battlecruiser").toLowerCase();
        return ESCORT_OPTIONS[key] || ESCORT_OPTIONS.battlecruiser;
    }

    function escortLabel(key) {
        const opt = ESCORT_OPTIONS[key] || ESCORT_OPTIONS.battlecruiser;
        return t(opt.labelEn, opt.labelFr);
    }

    function getAvailableShips() {
        const escort = getEscortConfig();
        return {
            smallCargo: getShipCountOnPlanet(SHIP.SMALL_CARGO),
            largeCargo: getShipCountOnPlanet(SHIP.LARGE_CARGO),
            pathfinder: getShipCountOnPlanet(SHIP.PATHFINDER),
            spyProbe: getShipCountOnPlanet(SHIP.SPY_PROBE),
            battlecruiser: getShipCountOnPlanet(SHIP.BATTLECRUISER),
            destroyer: getShipCountOnPlanet(SHIP.DESTROYER),
            reaper: getShipCountOnPlanet(SHIP.REAPER),
            escortCount: getShipCountOnPlanet(escort.id),
            escortKey: escort.key
        };
    }

    /**
     * Divides all available cargos + pathfinders by free expedition slots,
     * then adds 1 spy probe + 1 chosen escort (Reaper / BC / Destroyer) per expedition.
     */
    function calculateFleetComposition(ships, freeExpos) {
        const slots = Math.max(1, freeExpos);
        const escort = getEscortConfig();

        const usableSC = Math.max(0, ships.smallCargo - (settings.reserveSmallCargo || 0));
        const usableLC = Math.max(0, ships.largeCargo - (settings.reserveLargeCargo || 0));
        const usablePF = Math.max(0, ships.pathfinder - (settings.reservePathfinder || 0));

        const sc = Math.floor(usableSC / slots);
        const lc = Math.floor(usableLC / slots);
        const pf = Math.floor(usablePF / slots);

        const probe = ships.spyProbe >= 1 ? 1 : 0;
        const escortQty = ships.escortCount >= 1 ? 1 : 0;

        return {
            smallCargo: sc,
            largeCargo: lc,
            pathfinder: pf,
            spyProbe: probe,
            escortShip: escort.key,
            escortId: escort.id,
            escortQty: escortQty,
            // Legacy field kept for panel compatibility when escort is BC
            battlecruiser: escort.key === "battlecruiser" ? escortQty : 0,
            freeExpos: slots
        };
    }

    function compositionIsValid(comp) {
        // At least some cargo or pathfinders
        const hasCargo = (comp.smallCargo || 0) + (comp.largeCargo || 0) > 0;
        const hasPF = (comp.pathfinder || 0) > 0;
        return hasCargo || hasPF;
    }

    // ============================================================
    // SHIP SELECTION
    // ============================================================

    function setShipAmount(techId, amount) {
        if (amount <= 0) return false;

        // Preferred: fleetDispatcher.selectShip (vanilla + OGLight + AGO)
        try {
            const fd = window.fleetDispatcher;
            if (fd && typeof fd.selectShip === "function") {
                fd.selectShip(techId, amount);
                if (typeof fd.refresh === "function") {
                    try { fd.refresh(); } catch (_) {}
                }
                return true;
            }
        } catch (_) {}

        // Fallback: DOM input
        const li =
        document.querySelector(`li[data-technology="${techId}"]`) ||
        document.querySelector(`.technology[data-technology="${techId}"]`);
        if (li) {
            const clickTarget = li.querySelector("a, .icon, img, span") || li;
            try { clickTarget.click(); } catch (_) {}
        }

        const input =
        document.querySelector(`input[name="am${techId}"]`) ||
        document.querySelector(`#ship_${techId}`) ||
        document.querySelector(`li[data-technology="${techId}"] input`) ||
        document.querySelector(`.technology[data-technology="${techId}"] input`);

        if (input) {
            input.focus();
            input.value = String(amount);
            input.dispatchEvent(new Event("input", { bubbles: true }));
            input.dispatchEvent(new Event("change", { bubbles: true }));
            input.dispatchEvent(new Event("blur", { bubbles: true }));
            return true;
        }

        return false;
    }

    async function selectShipsAuto(comp) {
        // Reset previous selection so we start clean (OGLight-safe)
        try {
            const fd = window.fleetDispatcher;
            if (fd && typeof fd.resetShips === "function") {
                fd.resetShips();
                if (typeof fd.refresh === "function") fd.refresh();
                await sleep(200);
            }
        } catch (_) {}

        const escortId = comp.escortId || getEscortConfig().id;
        const escortQty = comp.escortQty || 0;

        const order = [
            [SHIP.SMALL_CARGO, comp.smallCargo],
            [SHIP.LARGE_CARGO, comp.largeCargo],
            [SHIP.PATHFINDER, comp.pathfinder],
            [SHIP.SPY_PROBE, comp.spyProbe],
            [escortId, escortQty]
        ];

        for (const [id, qty] of order) {
            if (qty > 0) {
                setShipAmount(id, qty);
                await sleep(200);
            }
        }

        // Final refresh so OGLight UI gauges update
        try {
            if (window.fleetDispatcher?.refresh) window.fleetDispatcher.refresh();
        } catch (_) {}
    }

    // ============================================================
    // PRESET DROPDOWN (legacy modes)
    // ============================================================

    function getStandardFleetDropdownAnchor() {
        const dropdown =
        document.querySelector("span.dropdown.standardFleetTemplateSelect") ||
        document.querySelector("span.standardFleetTemplateSelect");
        if (!dropdown) return null;
        return dropdown.querySelector(":scope > a") || dropdown.querySelector("a");
    }

    function findStandardExpeditionOption() {
        const options = document.querySelectorAll(
            'a[data-value], li a[data-value], .dropdown-menu a'
        );
        for (const option of options) {
            if (!isVisible(option)) continue;
            const value = option.getAttribute("data-value");
            const text = normalizedText(option);
            if (value === "2062" || text === "EXPEDITION" || text.includes("EXPÉDITION") || text.includes("EXPEDITION")) {
                return option;
            }
        }
        return null;
    }

    function findLastFleetOption() {
        const candidates = document.querySelectorAll("a[data-value], li a, .dropdown-menu a, a");
        const names = ["LAST FLEET", "LASTFLEET", "DERNIÈRE FLOTTE", "DERNIERE FLOTTE"];
        for (const el of candidates) {
            if (!isVisible(el)) continue;
            const text = normalizedText(el);
            if (names.some(n => text.includes(n))) return el;
        }
        return (
            document.querySelector("#lastFleet") ||
            document.querySelector(".lastFleet") ||
            document.querySelector("[data-template='lastFleet']")
        );
    }

    async function openFleetPreset() {
        const anchor = await waitForCondition(
            () => getStandardFleetDropdownAnchor(),
                                              12000,
                                              t("Standard Fleet dropdown", "menu de flotte standard")
        );
        anchor.click();
    }

    async function selectFleetPreset() {
        if (settings.fleetMode === "last") {
            const last = await waitForCondition(
                () => findLastFleetOption(),
                                                8000,
                                                t("Last Fleet option", "option Dernière flotte")
            );
            last.click();
            log(t("Selected: Last Fleet", "Sélectionné : Dernière flotte"));
            return;
        }

        // fleetMode "expedition" or "standard" → preset named EXPEDITION
        const expedition = await waitForCondition(
            () => findStandardExpeditionOption(),
                                                  10000,
                                                  t("EXPEDITION preset option", "option préréglage EXPEDITION")
        );
        expedition.click();
        log(t("Selected: EXPEDITION preset", "Sélectionné : préréglage EXPEDITION"));
    }

    // ============================================================
    // AGO EXPEDITION ROUTINE
    // ============================================================

    function getExpeditionRoutineElement() {
        const el = document.getElementById(AGO_ROUTINE_ID);
        return el && el.isConnected ? el : null;
    }

    function isExpeditionRoutineSelected(el) {
        if (!el) return false;
        return (
            el.classList.contains("on") ||
            el.classList.contains("selected") ||
            el.classList.contains("active")
        );
    }

    async function activateExpeditionRoutine() {
        currentStage = t("Activating AGO Expedition routine", "Activation de la routine AGO Expédition");
        updatePanel();

        const routine = await waitForCondition(
            () => getExpeditionRoutineElement(),
                                               15000,
                                               t("AGO Expedition routine (#ago_routine_7)", "routine AGO Expédition (#ago_routine_7)")
        );

        // Click even if already "on" so AGO re-applies mission + coords
        log(t("Clicking AGO Expedition routine.", "Clic sur la routine AGO Expédition."));

        try {
            routine.click();
        } catch (_) {
            routine.dispatchEvent(
                new MouseEvent("click", { bubbles: true, cancelable: true, view: window })
            );
        }

        // Give AGO time to process; selection class is best-effort only
        await sleep(800);

        try {
            await waitForCondition(
                () => {
                    const current = getExpeditionRoutineElement();
                    return current && isExpeditionRoutineSelected(current);
                },
                5000,
                t("AGO Expedition routine selection", "sélection de la routine AGO Expédition")
            );
            log(t("✓ AGO Expedition routine selected.", "✓ Routine AGO Expédition sélectionnée."));
        } catch (_) {
            // Class may not flip on every AGO version — mission is still set by the click
            log(
                t(
                    "AGO routine clicked (selection class not confirmed — continuing).",
                  "Routine AGO cliquée (classe non confirmée — poursuite)."
                ),
                "WARN"
            );
        }

        ensureExpeditionMission();
        return true;
    }

    // ============================================================
    // CONTINUE + SEND  (AGO / OGLight / vanilla)
    // Flow after ships:
    //   1) Continue → next screen (coords show in #ago_continue_coords)
    //   2) Click #dispatchFleet ("Send fleet")
    // ============================================================

    function ensureExpeditionMission() {
        try {
            const fd = window.fleetDispatcher;
            if (!fd) return false;

            const body = getCurrentBody();
            if (fd.targetPlanet) {
                if (!fd.targetPlanet.galaxy && body.galaxy) fd.targetPlanet.galaxy = body.galaxy;
                if (!fd.targetPlanet.system && body.system) fd.targetPlanet.system = body.system;
                fd.targetPlanet.position = 16;
                fd.targetPlanet.type = 1;
            }

            if (typeof fd.selectMission === "function") {
                fd.selectMission(15);
            } else {
                fd.mission = 15;
            }

            if (typeof fd.expeditionTime !== "undefined") {
                fd.expeditionTime = fd.expeditionTime || 1;
            }
            if (typeof fd.updateExpeditionTime === "function") {
                try { fd.updateExpeditionTime(); } catch (_) {}
            }
            if (typeof fd.refresh === "function") {
                try { fd.refresh(); } catch (_) {}
            }
            return true;
        } catch (e) {
            console.warn("ensureExpeditionMission failed", e);
            return false;
        }
    }

    function clickIfPresent(el) {
        if (!el || !el.isConnected) return false;
        try {
            el.click();
            return true;
        } catch (_) {
            try {
                el.dispatchEvent(
                    new MouseEvent("click", { bubbles: true, cancelable: true, view: window })
                );
                return true;
            } catch (__) {
                return false;
            }
        }
    }

    function getAgoContinueCoordsText() {
        const td = document.getElementById("ago_continue_coords");
        return td ? (td.textContent || "").replace(/\s+/g, "").trim() : "";
    }

    /**
     * Click the Continue control that advances from ship selection
     * to the coordinates / mission confirmation screen.
     * AGO shows the target in #ago_continue_coords (e.g. 4:20:16).
     */
    async function clickContinueToCoords() {
        // Prefer explicit continue buttons (vanilla multi-step)
        const continueIds = [
            "continueToFleet2",
 "continueToFleet3",
 "continueToFleet1"
        ];
        for (const id of continueIds) {
            const btn = document.getElementById(id);
            if (btn && clickIfPresent(btn)) {
                log(t(`Continue clicked: #${id}`, `Continuer cliqué : #${id}`));
                return id;
            }
        }

        // AGO continue wrappers / links near coords cell
        const agoSelectors = [
            "#ago_continue_coords",
 "td#ago_continue_coords",
 "#ago_continue_coords a",
 "[id*='ago_continue'] a",
 "[id*='ago_continue']",
 "a[ago-data*='continue']",
 ".ago_continue",
 "#fleet1 .continue",
 "#fleet1 a.continue",
 "a#continueToFleet2",
 "a#continueToFleet3"
        ];
        for (const sel of agoSelectors) {
            const el = document.querySelector(sel);
            if (!el) continue;
            // If it's the coords TD, try clicking a parent button or sibling link
            if (el.id === "ago_continue_coords") {
                const parentLink =
                el.closest("a") ||
                el.parentElement?.querySelector("a") ||
                el.closest("tr")?.querySelector("a.continue, a.button, button");
                if (parentLink && clickIfPresent(parentLink)) {
                    log(t("Continue clicked via ago_continue_coords parent.", "Continuer via parent ago_continue_coords."));
                    return "ago_continue_coords_parent";
                }
                // Some AGO builds make the TD itself clickable
                if (clickIfPresent(el)) {
                    log(t("Continue clicked: #ago_continue_coords", "Continuer cliqué : #ago_continue_coords"));
                    return "ago_continue_coords";
                }
                continue;
            }
            if (clickIfPresent(el)) {
                log(t(`Continue clicked: ${sel}`, `Continuer cliqué : ${sel}`));
                return sel;
            }
        }

        // fleetDispatcher continue API
        try {
            const fd = window.fleetDispatcher;
            if (fd && typeof fd.trySubmitFleet1 === "function") {
                fd.trySubmitFleet1();
                log(t("Continue via fleetDispatcher.trySubmitFleet1", "Continuer via fleetDispatcher.trySubmitFleet1"));
                return "trySubmitFleet1";
            }
        } catch (_) {}

        throw new Error(
            t(
                "Continue control not found (expected #continueToFleet2 or #ago_continue_coords).",
              "Contrôle Continuer introuvable (#continueToFleet2 ou #ago_continue_coords attendu)."
            )
        );
    }

    /**
     * Final send: click AGO/vanilla #dispatchFleet ("Send fleet").
     */
    async function clickDispatchFleet() {
        // Primary: exact element provided by the user
        const primary = document.getElementById("dispatchFleet");
        if (primary && clickIfPresent(primary)) {
            log(t("Send fleet clicked: #dispatchFleet", "Envoi cliqué : #dispatchFleet"));
            return "dispatchFleet";
        }

        // AGO data-attribute variants
        const agoSend = document.querySelector(
            'a[ago-data*="dispatchFleet"], a[ago-data*="dispatch"], [ago-data*="dispatchFleet"]'
        );
        if (agoSend && clickIfPresent(agoSend)) {
            log(t("Send fleet clicked: ago-data dispatchFleet", "Envoi cliqué : ago-data dispatchFleet"));
            return "ago-data-dispatchFleet";
        }

        // Text-based "Send fleet" / "Envoyer la flotte"
        const anchors = document.querySelectorAll("a, button");
        for (const a of anchors) {
            const text = (a.textContent || "").replace(/\s+/g, " ").trim().toUpperCase();
            if (
                text === "SEND FLEET" ||
                text === "ENVOYER LA FLOTTE" ||
                text === "ENVOYER" ||
                text.includes("SEND FLEET") ||
                text.includes("ENVOYER LA FLOTTE")
            ) {
                if (clickIfPresent(a)) {
                    log(t(`Send fleet clicked by label: ${text}`, `Envoi cliqué par libellé : ${text}`));
                    return "label:" + text;
                }
            }
        }

        // Legacy fallbacks
        const fallbacks = ["sendFleet", "continueToFleet3"];
        for (const id of fallbacks) {
            const btn = document.getElementById(id);
            if (btn && clickIfPresent(btn)) {
                log(t(`Send fallback clicked: #${id}`, `Envoi fallback : #${id}`));
                return id;
            }
        }

        throw new Error(
            t(
                "Send button #dispatchFleet not found.",
              "Bouton d'envoi #dispatchFleet introuvable."
            )
        );
    }

    // ============================================================
    // ERROR CLASSIFICATION
    // ============================================================

    function classifyGameError(text) {
        const value = String(text || "").toUpperCase().replace(/\s+/g, " ");

        if (
            value.includes("NO MORE SHIP") ||
            value.includes("NO SHIPS") ||
            value.includes("NOT ENOUGH SHIP") ||
            value.includes("PAS ASSEZ DE VAISSEAU") ||
            value.includes("PLUS DE VAISSEAUX") ||
            value.includes("KEINE SCHIFFE")
        ) {
            return "NO_SHIPS";
        }
        if (
            value.includes("FLEET SLOT") ||
            value.includes("MAXIMUM FLEET") ||
            value.includes("FLEET SLOTS") ||
            value.includes("PLUS DE SLOT DE FLOTTE") ||
            value.includes("PLUS DE SLOTS DE FLOTTE")
        ) {
            return "NO_FLEET_SLOTS";
        }
        if (
            value.includes("EXPEDITION SLOT") ||
            value.includes("EXPEDITION SLOTS") ||
            value.includes("MAXIMUM EXPEDITION") ||
            value.includes("PLUS DE SLOT D'EXPEDITION") ||
            value.includes("PLUS DE SLOTS D'EXPEDITION") ||
            value.includes("PLUS DE SLOT D'EXPÉDITION")
        ) {
            return "NO_EXPEDITION_SLOTS";
        }
        if (
            value.includes("ERROR") ||
            value.includes("FEHLER") ||
            value.includes("ERREUR") ||
            value.includes("IMPOSSIBLE") ||
            value.includes("NOT POSSIBLE") ||
            value.includes("REACHED") ||
            value.includes("UNABLE") ||
            value.includes("FAILED")
        ) {
            return "GAME_ERROR";
        }
        return null;
    }

    function getVisibleGameError() {
        const selectors = [
            ".fadeBox.red",
 ".errorBox",
 ".status_error",
 ".error_box",
 ".error",
 ".warning",
 ".alert"
        ];
        for (const sel of selectors) {
            for (const el of document.querySelectorAll(sel)) {
                if (!isVisible(el)) continue;
                const text = normalizedText(el);
                const type = classifyGameError(text);
                if (type) return { type, text };
            }
        }
        return null;
    }

    function checkAndThrowGameError() {
        const error = getVisibleGameError();
        if (!error) return;
        const exception = new Error(`Game Error: ${error.text}`);
        exception.gameErrorType = error.type;
        throw exception;
    }

    // ============================================================
    // EVENT LIST — RETURN TIMES
    // ============================================================

    /**
     * Opens the event details panel if it is closed.
     */
    function ensureEventListOpen() {
        const closed = document.getElementById("js_eventDetailsClosed");
        if (closed && isVisible(closed)) {
            try {
                closed.click();
            } catch (_) {}
        }
        // OGLight / AGO sometimes use other toggles
        const alt =
        document.querySelector("#eventboxFilled") ||
        document.querySelector(".eventToggle") ||
        document.querySelector("#js_eventDetailsOpen");
        if (alt && !document.querySelector("#eventContent tr.eventFleet")) {
            try { alt.click(); } catch (_) {}
        }
    }

    function parseCountdownToMs(text) {
        if (!text) return 0;
        const t = text.toLowerCase().replace(/\s+/g, " ").trim();
        let total = 0;
        const h = t.match(/(\d+)\s*h/);
        const m = t.match(/(\d+)\s*m/);
        const s = t.match(/(\d+)\s*s/);
        if (h) total += parseInt(h[1], 10) * 3600;
        if (m) total += parseInt(m[1], 10) * 60;
        if (s) total += parseInt(s[1], 10);
        return total * 1000;
    }

    function rowArrivalMs(row) {
        const arrivalAttr = row.getAttribute("data-arrival-time");
        if (arrivalAttr) {
            const ts = parseInt(arrivalAttr, 10) * 1000;
            if (ts > 0) return ts;
        }
        const counter = row.querySelector(".countDown span, .countDown");
        if (counter) {
            const ms = parseCountdownToMs(counter.textContent);
            if (ms > 0) return Date.now() + ms;
        }
        return null;
    }

    /**
     * Expedition lifecycle (from event list):
     *  1) Outbound  — data-mission-type="15" data-return-flight="false"
     *                 (flight to deep space, e.g. ~14–17 min)
     *  2) Hold      — ~1 hour observing in deep space
     *  3) Return    — data-mission-type="15" data-return-flight="true"
     *                 (flight home; slot frees when this arrives)
     *
     * We only care about RETURN rows: that is when the fleet lands
     * back on the moon/planet and an expedition slot is freed.
     */
    function getExpeditionReturnRows() {
        ensureEventListOpen();
        const rows = document.querySelectorAll(
            '#eventContent tr.eventFleet[data-mission-type="15"]'
        );
        const returns = [];
        for (const row of rows) {
            const isReturn = row.getAttribute("data-return-flight") === "true";
            if (!isReturn) continue;
            const arrival = rowArrivalMs(row);
            if (arrival && arrival > Date.now()) {
                returns.push({
                    row,
                    arrivalMs: arrival,
                    pair: row.getAttribute("ago-events-pair") || null,
                             id: row.id || null
                });
            }
        }
        returns.sort((a, b) => a.arrivalMs - b.arrivalMs);
        return returns;
    }

    /**
     * Earliest moment an expedition slot will free (ms timestamp).
     * Uses RETURN legs only. Fallback: 1h45m if none parseable.
     */
    function getEarliestExpeditionReturnMs() {
        const returns = getExpeditionReturnRows();
        if (returns.length > 0) {
            return returns[0].arrivalMs;
        }

        // No return rows yet — try to estimate from outbound + 1h hold + same flight
        ensureEventListOpen();
        const outbound = document.querySelectorAll(
            '#eventContent tr.eventFleet[data-mission-type="15"][data-return-flight="false"]'
        );
        let earliestEstimate = null;
        const HOLD_MS = 60 * 60 * 1000; // 1 hour observe
        for (const row of outbound) {
            const arriveDeep = rowArrivalMs(row);
            if (!arriveDeep) continue;
            // Rough: arrive deep + 1h hold + same outbound duration again
            const flightMs = Math.max(0, arriveDeep - Date.now());
            const homeMs = arriveDeep + HOLD_MS + flightMs;
            if (homeMs > Date.now() && (earliestEstimate === null || homeMs < earliestEstimate)) {
                earliestEstimate = homeMs;
            }
        }
        return earliestEstimate;
    }

    function getExpeditionReturnSummary() {
        const returns = getExpeditionReturnRows();
        return {
            count: returns.length,
            earliestMs: returns.length ? returns[0].arrivalMs : getEarliestExpeditionReturnMs(),
 all: returns
        };
    }

    // ============================================================
    // RECOVERY LABEL / COUNTDOWN
    // ============================================================

    function getRecoveryLabel() {
        switch (state.lastErrorType) {
            case "NO_SHIPS":
                return t("NO MORE SHIPS AVAILABLE", "PLUS DE VAISSEAUX DISPONIBLES");
            case "NO_FLEET_SLOTS":
                return t("NO MORE FLEET SLOTS AVAILABLE", "PLUS DE SLOTS DE FLOTTE DISPONIBLES");
            case "NO_EXPEDITION_SLOTS":
                return t("NO MORE EXPEDITION SLOTS AVAILABLE", "PLUS DE SLOTS D'EXPÉDITION DISPONIBLES");
            default:
                return t("RECOVERY / WAITING FOR RETURNS", "RÉCUPÉRATION / ATTENTE RETOURS");
        }
    }

    function startCountdownTimer() {
        stopCountdown();
        updateCountdown();
        countdownTimer = setInterval(updateCountdown, 1000);
    }

    function stopCountdown() {
        if (countdownTimer) {
            clearInterval(countdownTimer);
            countdownTimer = null;
        }
    }

    function formatDuration(ms) {
        const totalSeconds = Math.max(0, Math.floor(ms / 1000));
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;
        return (
            String(hours).padStart(2, "0") +
            ":" +
            String(minutes).padStart(2, "0") +
            ":" +
            String(seconds).padStart(2, "0")
        );
    }

    function updateCountdown() {
        if (!countdownElement) return;
        if (!state.recovery) {
            countdownElement.textContent = "";
            countdownElement.style.display = "none";
            return;
        }
        countdownElement.style.display = "block";

        // Live-refresh from event list when possible
        const live = getEarliestExpeditionReturnMs();
        if (live && live > Date.now()) {
            const buffered = live + 20 * 1000;
            if (!state.recoveryUntil || buffered < state.recoveryUntil) {
                state.recoveryUntil = buffered;
            }
        }

        const until = state.recoveryUntil || (state.recoveryStartedAt + RECOVERY_DURATION_MS);
        const remaining = Math.max(0, until - Date.now());
        const returns = getExpeditionReturnRows();
        const returnInfo =
        returns.length > 0
        ? t(
            `${returns.length} return(s) tracked — next lands in ${formatDuration(returns[0].arrivalMs - Date.now())}`,
            `${returns.length} retour(s) suivi(s) — prochain atterrissage dans ${formatDuration(returns[0].arrivalMs - Date.now())}`
        )
        : t("Waiting for return leg in event list", "Attente de la jambe retour dans la liste d'événements");

        countdownElement.textContent =
        `${getRecoveryLabel()}\n` +
        `${t("NEXT SLOT FREE", "PROCHAIN SLOT LIBRE")}: ${formatDuration(remaining)}\n` +
        returnInfo;
    }

    // ============================================================
    // ENTER RECOVERY
    // ============================================================

    function startRecovery(reason, type) {
        if (state.recovery) return;

        state.recovery = true;
        state.paused = false;
        state.recoveryStartedAt = Date.now();
        state.recoveryReason = reason;
        state.lastError = reason;
        state.lastErrorType = type || "GENERAL_ERROR";

        /*
         * Wait until the FIRST returning expedition lands back home.
         * Outbound countdowns (~14 min) must be ignored — the slot
         * only frees on data-return-flight="true".
         */
        const summary = getExpeditionReturnSummary();
        const earliestReturn = summary.earliestMs;

        if (earliestReturn && earliestReturn > Date.now()) {
            // Small buffer so ships are available after landing
            state.recoveryUntil = earliestReturn + 20 * 1000;
            log(
                t(
                    `Waiting for first expedition RETURN home (${formatDuration(earliestReturn - Date.now())}) — ${summary.count} return leg(s) tracked.`,
                  `Attente du premier RETOUR d'expédition (${formatDuration(earliestReturn - Date.now())}) — ${summary.count} jambe(s) retour suivie(s).`
                )
            );
        } else {
            state.recoveryUntil = Date.now() + RECOVERY_DURATION_MS;
            log(
                t(
                    "No return leg parseable yet — using 1h45m fallback until event list updates.",
                  "Aucune jambe retour lisible — fallback 1h45m jusqu'à mise à jour de la liste."
                ),
                "WARN"
            );
        }

        saveState();
        log(`${getRecoveryLabel()} — recovery started.`, "ERROR");
        notifyUser(
            "Shurukn Ultimate Expedtions",
            t(
                "Waiting for next expedition return to free a slot.",
              "Attente du prochain retour d'expédition pour libérer un slot."
            )
        );
        startCountdownTimer();

        if (!recoveryRunning) runRecovery();
    }

    // ============================================================
    // RECOVERY ENGINE
    // ============================================================

    async function runRecovery() {
        if (recoveryRunning) return;
        recoveryRunning = true;

        try {
            startCountdownTimer();

            while (state.active && state.recovery) {
                // Always re-read RETURN legs from the event list
                const earliest = getEarliestExpeditionReturnMs();
                if (earliest && earliest > Date.now()) {
                    const candidate = earliest + 20 * 1000;
                    // Keep the soonest accurate return; do not push later
                    if (!state.recoveryUntil || candidate < state.recoveryUntil + 5000) {
                        state.recoveryUntil = candidate;
                        saveState();
                    }
                }

                // Also exit early if a free expo slot already appeared
                const slotsNow = getSlots();
                if (slotsNow && freeExpoSlots(slotsNow) > 0 && freeFleetSlots(slotsNow) > 0) {
                    log(
                        t(
                            `Free expo slot detected (${slotsNow.expoUsed}/${slotsNow.expoTotal}) — ending recovery early.`,
                          `Slot d'expédition libre détecté (${slotsNow.expoUsed}/${slotsNow.expoTotal}) — fin anticipée de la récupération.`
                        )
                    );
                    break;
                }

                const until = state.recoveryUntil || (state.recoveryStartedAt + RECOVERY_DURATION_MS);
                if (Date.now() >= until) break;

                const remaining = until - Date.now();
                // Near the end, poll more often so we catch the landing quickly
                const nextRefresh =
                remaining < 90 * 1000
                ? Math.min(20 * 1000, remaining)
                : Math.min(RECOVERY_REFRESH_MS, remaining);

                const returns = getExpeditionReturnRows();
                log(
                    t(
                        `Waiting for return. Next free in ~${Math.ceil(remaining / 1000)}s (${returns.length} return leg(s)). Refresh in ${Math.ceil(nextRefresh / 1000)}s.`,
                      `Attente retour. Prochain libre dans ~${Math.ceil(remaining / 1000)}s (${returns.length} jambe(s) retour). Actualisation dans ${Math.ceil(nextRefresh / 1000)}s.`
                    )
                );

                await sleep(nextRefresh);

                if (!state.active) return;

                // Reload only while still waiting (keeps event list fresh)
                if (state.recovery && Date.now() < (state.recoveryUntil || Infinity) - 5000) {
                    location.reload();
                    return;
                }
            }

            if (!state.active) return;

            // ---- RECOVERY FINISHED ----
            // Activate AGO routine, then resume normal loop (no forced reload)
            try {
                await activateExpeditionRoutine();
            } catch (e) {
                log(t("AGO routine activation failed after recovery — will retry in sequence.", "Échec activation routine AGO après récupération — nouvelle tentative dans la séquence."), "WARN");
            }

            state.recovery = false;
            state.recoveryStartedAt = 0;
            state.recoveryUntil = 0;
            state.recoveryReason = "";
            state.lastError = "";
            state.lastErrorType = "";
            state.currentStep = 0;
            state.previousRequested = false;
            resetStepStates();
            saveState();
            stopCountdown();

            log(
                t(
                    "Recovery complete. Resuming expedition loop.",
                  "Récupération terminée. Reprise de la boucle d'expéditions."
                )
            );
            notifyUser("Shurukn Ultimate Expedtions", "Recovery complete. Resuming expeditions.");

            await sleep(400);
            executeFleetSequence();
        } finally {
            recoveryRunning = false;
        }
    }

    // ============================================================
    // STEP STATE
    // ============================================================

    function resetStepStates() {
        state.stepStates = {};
        state.stepRetries = {};
        STEP_DEFINITIONS.forEach(step => {
            state.stepStates[step.id] = "waiting";
            state.stepRetries[step.id] = 0;
        });
    }

    function markStepProcessing(stepIndex, attempt) {
        const step = STEP_DEFINITIONS[stepIndex];
        state.currentStep = stepIndex;
        state.stepRetries[step.id] = attempt;
        state.stepStates[step.id] = "processing";
        saveState();
    }

    function markStepSuccess(stepIndex) {
        const step = STEP_DEFINITIONS[stepIndex];
        state.currentStep = stepIndex;
        state.stepStates[step.id] = "success";
        state.lastStepSuccessAt = Date.now();
        saveState();
    }

    function markStepFailed(stepIndex) {
        const step = STEP_DEFINITIONS[stepIndex];
        state.stepStates[step.id] = "failed";
        saveState();
    }

    // ============================================================
    // STEP RETRY ENGINE
    // ============================================================

    async function executeStepWithRetries(stepIndex, action) {
        const step = STEP_DEFINITIONS[stepIndex];
        if (!step) throw new Error("INVALID_STEP");

        if (state.stepStates[step.id] === "success") {
            log(t(`${stepName(step)} already achieved — skipping.`, `${stepName(step)} déjà réussie — étape ignorée.`));
            return true;
        }

        for (let attempt = 1; attempt <= RETRY_COUNT; attempt++) {
            if (!state.active || state.recovery) return false;
            await waitWhilePaused();

            markStepProcessing(stepIndex, attempt);
            currentStage = stepName(step);
            log(t(`${stepName(step)} — attempt ${attempt}/${RETRY_COUNT}.`, `${stepName(step)} — tentative ${attempt}/${RETRY_COUNT}.`));

            try {
                await action();
                checkAndThrowGameError();
                markStepSuccess(stepIndex);
                log(t(`✓ ${stepName(step)} achieved.`, `✓ ${stepName(step)} réussie.`));
                return true;
            } catch (error) {
                const reason = error instanceof Error ? error.message : String(error);
                const gameType = error?.gameErrorType || getVisibleGameError()?.type;

                log(
                    t(
                        `${stepName(step)} failed on attempt ${attempt}/${RETRY_COUNT}: ${reason}`,
                      `${stepName(step)} échouée à la tentative ${attempt}/${RETRY_COUNT} : ${reason}`
                    ),
                    "ERROR"
                );

                if (attempt >= RETRY_COUNT) {
                    markStepFailed(stepIndex);
                    if (
                        gameType === "NO_SHIPS" ||
                        gameType === "NO_FLEET_SLOTS" ||
                        gameType === "NO_EXPEDITION_SLOTS"
                    ) {
                        startRecovery(reason, gameType);
                        return false;
                    }
                    throw new Error(`${stepName(step)} failed after ${RETRY_COUNT} attempts: ${reason}`);
                }

                state.stepStates[step.id] = "processing";
                saveState();
                await humanizedSleep(settings.retryDelay);
            }
        }
        return false;
    }

    // ============================================================
    // FAST MODE — Galaxy STANDARD preset (Admiral required)
    // ============================================================

    function getExpeditionFleetTemplateDropdown() {
        return (
            document.querySelector("span.dropdown.expeditionFleetTemplateSelect") ||
            document.querySelector("span.expeditionFleetTemplateSelect") ||
            document.querySelector(".expeditionFleetTemplateSelect")
        );
    }

    function getExpeditionFleetTemplateAnchor() {
        const dropdown = getExpeditionFleetTemplateDropdown();
        if (!dropdown) return null;
        return dropdown.querySelector(":scope > a") || dropdown.querySelector("a");
    }

    function findStandardTemplateOption() {
        const options = document.querySelectorAll(
            'a[data-value], li a[data-value], .dropdown-menu a, ul.dropdown a, div.dropdownList a'
        );
        for (const option of options) {
            if (!isVisible(option) && option.offsetParent === null) {
                // still allow hidden menu items that just opened
            }
            const text = normalizedText(option);
            if (text === "STANDARD" || text.includes("STANDARD")) {
                return option;
            }
            // also accept data-value matching known STANDARD templates when text is empty
        }
        // broader scan including non-visible (dropdown list often off-screen)
        for (const option of document.querySelectorAll("a[data-value], li a")) {
            const text = normalizedText(option);
            if (text === "STANDARD" || text === FAST_PRESET_NAME) return option;
        }
        return null;
    }

    function getSendExpeditionTemplateButton() {
        return (
            document.getElementById("sendExpeditionFleetTemplateFleet") ||
            document.querySelector("#sendExpeditionFleetTemplateFleet") ||
            document.querySelector(".btn_system_action#sendExpeditionFleetTemplateFleet") ||
            document.querySelector('[onclick*="sendExpedtionFleetFromTemplate"], [onclick*="sendExpeditionFleetFromTemplate"]')
        );
    }

    async function openExpeditionTemplateDropdown() {
        const anchor = await waitForCondition(
            () => getExpeditionFleetTemplateAnchor(),
            10000,
            t("Expedition fleet template dropdown", "menu préréglage expédition galaxie")
        );
        const currentText = normalizedText(anchor);
        if (currentText === "STANDARD" || currentText.includes("STANDARD")) {
            return true; // already selected
        }
        anchor.click();
        await sleep(350);
        return true;
    }

    async function selectStandardTemplate() {
        const anchor = getExpeditionFleetTemplateAnchor();
        if (anchor && (normalizedText(anchor) === "STANDARD" || normalizedText(anchor).includes("STANDARD"))) {
            log(t("STANDARD preset already selected.", "Préréglage STANDARD déjà sélectionné."));
            return true;
        }

        await openExpeditionTemplateDropdown();

        const option = await waitForCondition(
            () => findStandardTemplateOption(),
            8000,
            t('Preset option "STANDARD"', 'option préréglage "STANDARD"')
        );
        option.click();
        await sleep(300);

        // Confirm selection on anchor
        const after = getExpeditionFleetTemplateAnchor();
        if (after && normalizedText(after).includes("STANDARD")) {
            log(t("Selected STANDARD expedition preset.", "Préréglage STANDARD sélectionné."));
            return true;
        }
        log(t("STANDARD clicked (confirmation soft).", "STANDARD cliqué (confirmation douce)."), "WARN");
        return true;
    }

    async function clickSendExpeditionTemplate() {
        const btn = await waitForCondition(
            () => {
                const el = getSendExpeditionTemplateButton();
                return el && isVisible(el) ? el : null;
            },
            8000,
            t("#sendExpeditionFleetTemplateFleet", "#sendExpeditionFleetTemplateFleet")
        );

        // Prefer native onclick when present
        try {
            if (typeof window.sendExpedtionFleetFromTemplate === "function") {
                window.sendExpedtionFleetFromTemplate();
                log(t("Send via sendExpedtionFleetFromTemplate()", "Envoi via sendExpedtionFleetFromTemplate()"));
                return "sendExpedtionFleetFromTemplate";
            }
            if (typeof window.sendExpeditionFleetFromTemplate === "function") {
                window.sendExpeditionFleetFromTemplate();
                log(t("Send via sendExpeditionFleetFromTemplate()", "Envoi via sendExpeditionFleetFromTemplate()"));
                return "sendExpeditionFleetFromTemplate";
            }
        } catch (_) {}

        if (clickIfPresent(btn)) {
            log(t("Send clicked: #sendExpeditionFleetTemplateFleet", "Envoi cliqué : #sendExpeditionFleetTemplateFleet"));
            return "sendExpeditionFleetTemplateFleet";
        }
        throw new Error(t("Could not click send expedition template button.", "Impossible de cliquer le bouton d'envoi de préréglage."));
    }

    /**
     * Fast path: lock origin → Galaxy → STANDARD → send → repeat until slots full → verify fleet tab.
     */
    async function executeFastModeSequence() {
        if (sequenceRunning || !state.active || state.paused || state.recovery) return;
        sequenceRunning = true;
        currentStage = t("FAST MODE", "MODE RAPIDE");

        try {
            log(t("Fast Mode active (Admiral + STANDARD preset).", "Mode Rapide actif (Amiral + préréglage STANDARD)."));

            // Origin lock
            if (enforcePlanetLock()) {
                await sleep(1200);
            }
            lockPlanetIfNecessary();

            // Ensure Galaxy page
            if (!isGalaxyPage()) {
                log(t("Navigating to Galaxy for fast expeditions.", "Navigation vers Galaxie pour expéditions rapides."));
                goToGalaxy();
                await sleep(1800);
                await waitForCondition(
                    () => isGalaxyPage() || getExpeditionFleetTemplateDropdown(),
                    12000,
                    t("Galaxy page / expedition template dropdown", "page Galaxie / menu préréglage")
                );
            }

            let consecutiveFails = 0;
            const maxBurst = 20; // safety against infinite tight loop

            for (let i = 0; i < maxBurst && state.active && !state.paused && !state.recovery; i++) {
                await waitWhilePaused();
                if (!state.active || state.recovery) break;

                // Parse slots if possible (may be on galaxy or need movement link)
                const slots = getSlots();
                if (slots) {
                    state.lastSlots = slots;
                    saveState();
                    const freeExpo = freeExpoSlots(slots);
                    const freeFleet = freeFleetSlots(slots);
                    log(
                        t(
                            `Slots — Fleet: ${slots.fleetUsed}/${slots.fleetTotal} | Expo: ${slots.expoUsed}/${slots.expoTotal} (free: ${freeExpo})`,
                            `Slots — Flotte: ${slots.fleetUsed}/${slots.fleetTotal} | Expo: ${slots.expoUsed}/${slots.expoTotal} (libres: ${freeExpo})`
                        )
                    );
                    if (freeExpo <= 0 || freeFleet <= 0) {
                        log(t("No free slots — leaving Fast Mode burst.", "Plus de slots libres — fin du burst Mode Rapide."));
                        break;
                    }
                }

                currentStage = t("Fast send STANDARD", "Envoi rapide STANDARD");
                updatePanel();

                try {
                    // Stay on galaxy
                    if (!isGalaxyPage() && !getExpeditionFleetTemplateDropdown()) {
                        goToGalaxy();
                        await sleep(1500);
                    }

                    await selectStandardTemplate();
                    await sleep(200);
                    await clickSendExpeditionTemplate();
                    await sleep(600);

                    checkAndThrowGameError();

                    state.cycle++;
                    state.totalSent = (state.totalSent || 0) + 1;
                    saveState();
                    consecutiveFails = 0;

                    log(
                        t(
                            `FAST EXPEDITION #${state.cycle} SENT (STANDARD).`,
                            `EXPÉDITION RAPIDE #${state.cycle} ENVOYÉE (STANDARD).`
                        )
                    );

                    // Optional inter-expedition delay
                    const between = Math.max(0, Math.min(MAX_DELAY_MS, settings.delayBetweenExpeditionsMs || 0));
                    if (between > 0) {
                        currentStage = t(`Wait ${formatDuration(between)}`, `Attente ${formatDuration(between)}`);
                        updatePanel();
                        await humanizedSleep(between);
                    } else {
                        await sleep(350);
                    }
                } catch (err) {
                    consecutiveFails++;
                    const reason = err instanceof Error ? err.message : String(err);
                    const gameType = err?.gameErrorType || getVisibleGameError()?.type;
                    log(t(`Fast send failed: ${reason}`, `Échec envoi rapide : ${reason}`), "ERROR");

                    if (
                        gameType === "NO_SHIPS" ||
                        gameType === "NO_FLEET_SLOTS" ||
                        gameType === "NO_EXPEDITION_SLOTS"
                    ) {
                        startRecovery(reason, gameType);
                        return;
                    }
                    if (consecutiveFails >= 3) {
                        startRecovery(reason, gameType || "GENERAL_ERROR");
                        return;
                    }
                    await sleep(800);
                }
            }

            // Verify on fleet tab that slots are taken
            if (state.active && !state.recovery) {
                log(t("Verifying slots on Fleet tab…", "Vérification des slots sur l'onglet Flotte…"));
                goToFleetDispatch(state.lockedPlanetId || getPlanetId());
                await sleep(2000);

                const slotsFinal = getSlots();
                if (slotsFinal) {
                    state.lastSlots = slotsFinal;
                    saveState();
                    const freeExpo = freeExpoSlots(slotsFinal);
                    const freeFleet = freeFleetSlots(slotsFinal);
                    log(
                        t(
                            `Post-burst slots — Expo: ${slotsFinal.expoUsed}/${slotsFinal.expoTotal} (free: ${freeExpo})`,
                            `Slots post-burst — Expo: ${slotsFinal.expoUsed}/${slotsFinal.expoTotal} (libres: ${freeExpo})`
                        )
                    );

                    if (freeExpo > 0 && freeFleet > 0) {
                        // More capacity — continue immediately
                        const between = Math.max(0, Math.min(MAX_DELAY_MS, settings.delayBetweenExpeditionsMs || 0));
                        if (between > 0) await humanizedSleep(between);
                        setTimeout(() => executeFleetSequence(), 0);
                        return;
                    }
                }

                startRecovery(
                    t("All expedition slots filled (fast mode)", "Tous les slots d'expédition occupés (mode rapide)"),
                    "NO_EXPEDITION_SLOTS"
                );
            }
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            const gameType = error?.gameErrorType || getVisibleGameError()?.type || "GENERAL_ERROR";
            state.lastError = reason;
            saveState();
            log(t(`FAST MODE FAILED — recovery: ${reason}`, `MODE RAPIDE ÉCHOUÉ — récupération : ${reason}`), "ERROR");
            startRecovery(reason, gameType);
        } finally {
            sequenceRunning = false;
            updatePanel();
        }
    }

    // ============================================================
    // MAIN EXECUTION ENGINE
    // ============================================================

    async function executeFleetSequence() {
        if (sequenceRunning || !state.active || state.paused || state.recovery) return;
        if (state.pendingStartUntil && Date.now() < state.pendingStartUntil) return;

        // Fast Mode branch (Admiral + toggle)
        if (shouldUseFastMode()) {
            await executeFastModeSequence();
            return;
        }

        sequenceRunning = true;

        try {
            // ----------------------------------------------------
            // STEP 0 — NAVIGATE / PLANET LOCK / FLEET TAB
            // Ensures: correct moon/planet + Fleet menu selected
            // ----------------------------------------------------
            if (state.currentStep <= 0 && state.stepStates.navigate !== "success") {
                const ok = await executeStepWithRetries(0, async () => {
                    await humanizedSleep(settings.delayRefresh);

                    // 1) Switch to locked origin (moon 4:20:15 by default)
                    if (enforcePlanetLock()) {
                        await sleep(2000);
                        // After planet switch the page may reload — bail so the
                        // persisted step engine resumes on the new page.
                        if (!isFleetDispatchPage()) {
                            goToFleetDispatch(state.lockedPlanetId);
                            await sleep(6000);
                        }
                    }

                    // 2) Force Fleet Dispatch page / menu button
                    if (!isFleetDispatchPage() || !isFleetMenuSelected()) {
                        log(
                            t("Navigating to Fleet tab (fleetdispatch).", "Navigation vers l'onglet Flotte (fleetdispatch)."),
                            "WARN"
                        );
                        goToFleetDispatch(state.lockedPlanetId || getPlanetId());
                        await sleep(5000);
                        if (!isFleetDispatchPage()) {
                            throw new Error("Fleet Dispatch page navigation did not complete.");
                        }
                    }

                    // 3) Wait for OGLight / vanilla fleetDispatcher
                    const ready = await waitForFleetDispatcher(10000);
                    if (!ready) {
                        log(
                            t("fleetDispatcher not ready — continuing with DOM fallbacks.", "fleetDispatcher non prêt — poursuite avec fallbacks DOM."),
                            "WARN"
                        );
                    }

                    // 4) Confirm origin when meta/fleetDispatcher expose coords
                    const body = getCurrentBody();
                    if (body.galaxy && body.system && body.position) {
                        if (!coordsMatchSettings(body)) {
                            // Soft warning + one more switch attempt (do not hard-fail the cycle)
                            log(
                                t(
                                    `Origin mismatch: [${body.galaxy}:${body.system}:${body.position}] ${body.type} — retrying lock.`,
                                  `Origine incorrecte : [${body.galaxy}:${body.system}:${body.position}] ${body.type} — nouvelle tentative.`
                                ),
                                "WARN"
                            );
                            if (enforcePlanetLock()) {
                                await sleep(2500);
                            }
                        }
                    }

                    lockPlanetIfNecessary();
                    log(
                        t(
                            `On ${body.type || "?"} [${body.galaxy || "?"}:${body.system || "?"}:${body.position || "?"}] — Fleet tab ready.`,
                          `Sur ${body.type || "?"} [${body.galaxy || "?"}:${body.system || "?"}:${body.position || "?"}] — onglet Flotte prêt.`
                        )
                    );
                    checkAndThrowGameError();
                });
                if (!ok) return;
                state.currentStep = 1;
                saveState();
            }

            // ----------------------------------------------------
            // STEP 1 — PARSE SLOTS & SHIPS
            // ----------------------------------------------------
            if (state.currentStep <= 1 && state.stepStates.parse !== "success") {
                const ok = await executeStepWithRetries(1, async () => {
                    await sleep(600);

                    const slots = getSlots();
                    if (!slots) {
                        throw new Error("Could not parse fleet / expedition slots.");
                    }

                    state.lastSlots = slots;
                    saveState();

                    const freeExpo = freeExpoSlots(slots);
                    const freeFleet = freeFleetSlots(slots);

                    log(
                        t(
                            `Slots — Fleet: ${slots.fleetUsed}/${slots.fleetTotal} | Expo: ${slots.expoUsed}/${slots.expoTotal} (free: ${freeExpo})`,
                          `Slots — Flotte: ${slots.fleetUsed}/${slots.fleetTotal} | Expo: ${slots.expoUsed}/${slots.expoTotal} (libres: ${freeExpo})`
                        )
                    );

                    if (freeExpo <= 0 || freeFleet <= 0) {
                        const err = new Error(
                            freeExpo <= 0
                            ? "No free expedition slots"
                            : "No free fleet slots"
                        );
                        err.gameErrorType = freeExpo <= 0 ? "NO_EXPEDITION_SLOTS" : "NO_FLEET_SLOTS";
                        throw err;
                    }

                    if (settings.fleetMode === "auto") {
                        const ships = getAvailableShips();
                        const escortCfg = getEscortConfig();
                        log(
                            t(
                                `Ships — SC:${ships.smallCargo} LC:${ships.largeCargo} PF:${ships.pathfinder} Probe:${ships.spyProbe} ${escortCfg.labelEn}:${ships.escortCount}`,
                                `Vaisseaux — PT:${ships.smallCargo} GT:${ships.largeCargo} Éc:${ships.pathfinder} Sonde:${ships.spyProbe} ${escortCfg.labelFr}:${ships.escortCount}`
                            )
                        );

                        const comp = calculateFleetComposition(ships, freeExpo);
                        if (!compositionIsValid(comp)) {
                            const err = new Error("Not enough ships to form an expedition");
                            err.gameErrorType = "NO_SHIPS";
                            throw err;
                        }

                        state.lastFleetComposition = comp;
                        saveState();

                        const escortName = escortLabel(comp.escortShip);
                        log(
                            t(
                                `Composition (÷${comp.freeExpos}) → SC:${comp.smallCargo} LC:${comp.largeCargo} PF:${comp.pathfinder} +1 Probe +1 ${escortName}`,
                                `Composition (÷${comp.freeExpos}) → PT:${comp.smallCargo} GT:${comp.largeCargo} Éc:${comp.pathfinder} +1 Sonde +1 ${escortName}`
                            )
                        );
                    }

                    checkAndThrowGameError();
                });
                if (!ok) return;
                state.currentStep = 2;
                saveState();
            }

            // ----------------------------------------------------
            // STEP 2 — AGO ROUTINE (mission + pos 16)
            // ----------------------------------------------------
            if (state.currentStep <= 2 && state.stepStates.ago !== "success") {
                const ok = await executeStepWithRetries(2, async () => {
                    await activateExpeditionRoutine();
                    await humanizedSleep(1200);
                    // Reinforce mission via fleetDispatcher (OGLight-safe)
                    ensureExpeditionMission();
                    checkAndThrowGameError();
                });
                if (!ok) return;
                state.currentStep = 3;
                saveState();
            }

            // ----------------------------------------------------
            // STEP 3 — SELECT SHIPS / PRESET
            // ----------------------------------------------------
            if (state.currentStep <= 3 && state.stepStates.ships !== "success") {
                const ok = await executeStepWithRetries(3, async () => {
                    if (settings.fleetMode === "auto") {
                        const comp = state.lastFleetComposition;
                        if (!comp) throw new Error("No fleet composition calculated.");
                        await selectShipsAuto(comp);
                        await humanizedSleep(settings.delaySelect);
                        ensureExpeditionMission();
                    } else {
                        // "expedition" preset or "last" fleet
                        await openFleetPreset();
                        await humanizedSleep(settings.delayDropdown);
                        await selectFleetPreset();
                        await humanizedSleep(settings.delaySelect);
                        ensureExpeditionMission();
                    }
                    checkAndThrowGameError();
                });
                if (!ok) return;
                state.currentStep = 4;
                saveState();
            }

            // ----------------------------------------------------
            // STEP 4 — CONTINUE → coords screen
            // Advances past ship selection. AGO shows target in
            // #ago_continue_coords (e.g. 4:20:16 for expedition).
            // ----------------------------------------------------
            if (state.currentStep <= 4 && state.stepStates.continue !== "success") {
                const ok = await executeStepWithRetries(4, async () => {
                    await humanizedSleep(settings.delayContinue || 2000);
                    ensureExpeditionMission();

                    const method = await clickContinueToCoords();
                    log(
                        t(`Continue method: ${method}`, `Méthode Continuer : ${method}`)
                    );

                    // Wait for next screen / coords cell to update
                    await sleep(1500);

                    const coordsText = getAgoContinueCoordsText();
                    if (coordsText) {
                        log(
                            t(
                                `AGO continue coords: ${coordsText}`,
                              `Coords AGO continuer : ${coordsText}`
                            )
                        );
                    }

                    // If #dispatchFleet is not yet present, try one more continue
                    if (!document.getElementById("dispatchFleet")) {
                        const stillContinue =
                        document.getElementById("continueToFleet3") ||
                        document.getElementById("continueToFleet2");
                        if (stillContinue && isVisible(stillContinue)) {
                            clickIfPresent(stillContinue);
                            await sleep(1200);
                        }
                    }

                    checkAndThrowGameError();
                });
                if (!ok) return;
                state.currentStep = 5;
                saveState();
            }

            // ----------------------------------------------------
            // STEP 5 — SEND via #dispatchFleet
            // ----------------------------------------------------
            if (state.currentStep <= 5 && state.stepStates.send !== "success") {
                const ok = await executeStepWithRetries(5, async () => {
                    await humanizedSleep(settings.delaySend || 1500);

                    // Wait until the Send fleet control is available
                    await waitForCondition(
                        () =>
                        document.getElementById("dispatchFleet") ||
                        document.querySelector('a[ago-data*="dispatchFleet"]') ||
                        document.getElementById("sendFleet"),
                                           12000,
                                           t("Send fleet button (#dispatchFleet)", "bouton Envoyer (#dispatchFleet)")
                    );

                    const method = await clickDispatchFleet();
                    log(
                        t(`Send method: ${method}`, `Méthode d'envoi : ${method}`)
                    );

                    await sleep(2000);
                    checkAndThrowGameError();
                });
                if (!ok) return;
                state.currentStep = 6;
                saveState();
            }

            // ----------------------------------------------------
            // STEP 6 — VERIFY
            // ----------------------------------------------------
            if (state.currentStep <= 6 && state.stepStates.verify !== "success") {
                const ok = await executeStepWithRetries(6, async () => {
                    await sleep(1200);
                    checkAndThrowGameError();

                    const slotsAfter = getSlots();
                    if (slotsAfter && state.lastSlots) {
                        if (slotsAfter.expoUsed > state.lastSlots.expoUsed) {
                            log(
                                t(
                                    `Confirmed: Expo slots now ${slotsAfter.expoUsed}/${slotsAfter.expoTotal}`,
                                  `Confirmé : slots Expo maintenant ${slotsAfter.expoUsed}/${slotsAfter.expoTotal}`
                                )
                            );
                            state.lastSlots = slotsAfter;
                        }
                    }
                });
                if (!ok) return;
            }

            // ----------------------------------------------------
            // SUCCESS — PREPARE NEXT CYCLE
            // ----------------------------------------------------
            state.cycle++;
            state.totalSent = (state.totalSent || 0) + 1;
            saveState();

            log(
                t(
                    `EXPEDITION #${state.cycle} SENT SUCCESSFULLY.`,
                  `EXPÉDITION #${state.cycle} ENVOYÉE AVEC SUCCÈS.`
                )
            );
            notifyUser("Shurukn Ultimate Expedtions", `Expedition #${state.cycle} sent successfully.`);

            // Immediately check if more free slots remain
            const slotsNow = getSlots() || state.lastSlots;
            const freeNow = freeExpoSlots(slotsNow);
            const freeFleetNow = freeFleetSlots(slotsNow);

            resetStepStates();
            state.currentStep = 0;
            state.previousRequested = false;
            saveState();

            if (freeNow > 0 && freeFleetNow > 0) {
                currentStage = t("Preparing next expedition", "Préparation de la prochaine expédition");
                const between = Math.max(0, Math.min(MAX_DELAY_MS, settings.delayBetweenExpeditionsMs || 0));
                if (between > 0) {
                    log(
                        t(
                            `Inter-expedition delay: ${formatDuration(between)}`,
                            `Délai entre expéditions : ${formatDuration(between)}`
                        )
                    );
                    currentStage = t(`Wait ${formatDuration(between)}`, `Attente ${formatDuration(between)}`);
                    updatePanel();
                    await humanizedSleep(between);
                } else {
                    // ASAP: minimal pause only
                    await sleep(settings.humanize ? 400 : 200);
                }
                setTimeout(() => executeFleetSequence(), 0);
            } else {
                // All slots used → start recovery based on real return times
                log(
                    t(
                        "No free expedition/fleet slots left. Entering recovery.",
                        "Plus de slots d'expédition/flotte libres. Passage en récupération."
                    ),
                    "WARN"
                );
                startRecovery(
                    t("All expedition slots filled", "Tous les slots d'expédition sont occupés"),
                    "NO_EXPEDITION_SLOTS"
                );
            }
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            const gameType = error?.gameErrorType || getVisibleGameError()?.type || "GENERAL_ERROR";

            state.lastError = reason;
            saveState();

            log(
                t(
                    `SEQUENCE FAILED — entering recovery: ${reason}`,
                  `SÉQUENCE ÉCHOUÉE — récupération : ${reason}`
                ),
                "ERROR"
            );
            startRecovery(reason, gameType);
        } finally {
            sequenceRunning = false;
            updatePanel();
        }
    }

    // ============================================================
    // DRAGGING / MINIMIZE / VISIBILITY
    // ============================================================

    function makeDraggable(element, handle) {
        let startX = 0, startY = 0, startLeft = 0, startTop = 0;

        function mouseDown(event) {
            if (
                event.target.closest(".ae-controls") ||
                event.target.closest(".ae-buttons") ||
                event.target.closest("button")
            ) {
                return;
            }
            event.preventDefault();
            const rect = element.getBoundingClientRect();
            startX = event.clientX;
            startY = event.clientY;
            startLeft = rect.left;
            startTop = rect.top;
            document.addEventListener("mousemove", mouseMove);
            document.addEventListener("mouseup", mouseUp);
        }

        function mouseMove(event) {
            let left = startLeft + (event.clientX - startX);
            let top = startTop + (event.clientY - startY);
            left = Math.max(0, Math.min(left, window.innerWidth - element.offsetWidth));
            top = Math.max(0, Math.min(top, window.innerHeight - element.offsetHeight));
            element.style.left = `${left}px`;
            element.style.top = `${top}px`;
            element.style.right = "auto";
            element.style.bottom = "auto";
        }

        function mouseUp() {
            document.removeEventListener("mousemove", mouseMove);
            document.removeEventListener("mouseup", mouseUp);
            settings.panelPosition = { top: element.style.top, left: element.style.left };
            saveSettings();
        }

        handle.addEventListener("mousedown", mouseDown);
    }

    function toggleMinimize() {
        settings.panelMinimized = !settings.panelMinimized;
        saveSettings();
        applyMinimize();
    }

    function applyMinimize() {
        if (!panel) return;
        if (settings.panelMinimized) {
            panel.classList.add("ae-minimized");
            const btn = document.getElementById("aeToggleMinimize");
            if (btn) btn.textContent = "□";
        } else {
            panel.classList.remove("ae-minimized");
            const btn = document.getElementById("aeToggleMinimize");
            if (btn) btn.textContent = "_";
        }
    }

    function togglePanelVisibility() {
        settings.panelVisible = !settings.panelVisible;
        saveSettings();
        applyPanelVisibility();
    }

    function applyPanelVisibility() {
        if (!panel) return;
        panel.style.display = settings.panelVisible ? "" : "none";
    }

    document.addEventListener(
        "keydown",
        event => {
            if (event.ctrlKey && event.altKey && (event.key === "#" || event.code === "Digit3")) {
                event.preventDefault();
                togglePanelVisibility();
            }
        },
        true
    );

    // ============================================================
    // SETTINGS UI
    // ============================================================

    function createSlider(id, label, min, max, step, current) {
        return `
        <div class="ae-setting-row ae-slider-row">
        <label>
        <span>${label}</span>
        <strong id="${id}-val">${current}ms</strong>
        </label>
        <input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${current}">
        </div>
        `;
    }

    function formatDelayLabel(ms) {
        ms = Math.max(0, Math.min(MAX_DELAY_MS, ms | 0));
        if (ms < 1000) return `${ms}ms`;
        const totalSec = Math.floor(ms / 1000);
        const min = Math.floor(totalSec / 60);
        const sec = totalSec % 60;
        if (min <= 0) return `${sec}s`;
        return sec ? `${min}m ${sec}s` : `${min}m`;
    }

    function createLongDelaySlider(id, label, currentMs) {
        const val = Math.max(0, Math.min(MAX_DELAY_MS, currentMs || 0));
        return `
        <div class="ae-setting-row ae-slider-row">
        <label>
        <span>${label}</span>
        <strong id="${id}-val">${formatDelayLabel(val)}</strong>
        </label>
        <input type="range" id="${id}" min="0" max="${MAX_DELAY_MS}" step="5000" value="${val}">
        </div>
        `;
    }

    function openSettings() {
        if (document.querySelector("#shuruknUltimateExpeSettings")) return;

        const modal = document.createElement("div");
        modal.id = "shuruknUltimateExpeSettings";
        modal.innerHTML = `
        <div class="ae-settings-window">
        <div class="ae-settings-title">
        <span>⚙ ${t("PRO SETTINGS", "PARAMÈTRES PRO")}</span>
        <button id="aeSettingsClose" class="ae-close">×</button>
        </div>

        <div class="ae-settings-tabs">
        <button class="ae-set-tab active" data-target="general">${t("General", "Général")}</button>
        <button class="ae-set-tab" data-target="timings">${t("Timings", "Délais")}</button>
        </div>

        <div id="ae-set-general" class="ae-set-content">
        <div class="ae-setting-row">
        <label>${t("Fleet Source", "Source de flotte")}</label>
        <select id="aeFleetMode">
        <option value="auto">${t("Auto — divide ships ÷ expo slots", "Auto — diviser vaisseaux ÷ slots expo")}</option>
        <option value="expedition">${t("Preset EXPEDITION", "Préréglage EXPEDITION")}</option>
        <option value="last">${t("Last Fleet", "Dernière flotte")}</option>
        </select>
        </div>
        <div class="ae-setting-row">
        <label>${t("Fast Mode (Admiral)", "Mode Rapide (Amiral)")}</label>
        <input type="checkbox" id="aeFastMode" ${settings.fastMode ? "checked" : ""} title="${t(
            "Requires active Admiral. Uses Galaxy STANDARD preset + send button.",
            "Nécessite l'Amiral actif. Utilise le préréglage STANDARD galaxie + bouton envoyer."
        )}">
        </div>
        <div class="ae-setting-row" style="grid-template-columns:1fr;opacity:.75;font-size:11px;margin-top:-8px;">
        <span id="aeAdmiralStatus">${isAdmiralActive()
            ? t("✓ Admiral detected — Fast Mode available", "✓ Amiral détecté — Mode Rapide disponible")
            : t("✗ Admiral inactive — Fast Mode will fall back", "✗ Amiral inactif — Mode Rapide en secours")}</span>
        </div>
        <div class="ae-setting-row">
        <label>${t("Escort ship (1×)", "Vaisseau d'escorte (1×)")}</label>
        <select id="aeEscortShip">
        <option value="reaper">${t("Reaper", "Faucheur")}</option>
        <option value="battlecruiser">${t("Battlecruiser", "Croiseur de bataille")}</option>
        <option value="destroyer">${t("Destroyer", "Destructeur")}</option>
        </select>
        </div>
        <div class="ae-setting-row">
        <label>${t("Language", "Langue")}</label>
        <select id="aeLanguage">
        <option value="en">English</option>
        <option value="fr">Français</option>
        </select>
        </div>
        <div class="ae-setting-row">
        <label>${t("Theme", "Thème")}</label>
        <select id="aeTheme">
        <option value="dark">Dark</option>
        <option value="light">Light</option>
        </select>
        </div>
        <div class="ae-setting-row">
        <label>${t("Humanized timing", "Délais humanisés")}</label>
        <input type="checkbox" id="aeHumanize" ${settings.humanize ? "checked" : ""}>
        </div>
        <div class="ae-setting-row">
        <label>${t("Notifications", "Notifications")}</label>
        <input type="checkbox" id="aeNotifications" ${settings.notifications ? "checked" : ""}>
        </div>
        <div class="ae-setting-row">
        <label>${t("Origin type", "Type d'origine")}</label>
        <select id="aeLockType">
        <option value="moon">Moon / Lune</option>
        <option value="planet">Planet / Planète</option>
        </select>
        </div>
        <div class="ae-setting-row">
        <label>${t("Origin coords", "Coords origine")}</label>
        <span style="display:flex;gap:4px;align-items:center;">
        <input type="number" id="aeLockGalaxy" min="1" max="9" style="width:48px;padding:5px;" value="${settings.lockGalaxy || 4}">
        <span>:</span>
        <input type="number" id="aeLockSystem" min="1" max="499" style="width:56px;padding:5px;" value="${settings.lockSystem || 20}">
        <span>:</span>
        <input type="number" id="aeLockPosition" min="1" max="15" style="width:48px;padding:5px;" value="${settings.lockPosition || 15}">
        </span>
        </div>
        </div>

        <div id="ae-set-timings" class="ae-set-content" style="display:none;">
        ${createLongDelaySlider("aeDelayStart", t("Delayed start (PLAY only)", "Démarrage différé (LECTURE seul)"), settings.delayStartMs || 0)}
        ${createLongDelaySlider("aeDelayBetween", t("Delay between expeditions", "Délai entre expéditions"), settings.delayBetweenExpeditionsMs || 0)}
        ${createSlider("aeDelayRefresh", "Refresh / Stabilization", 500, 12000, 250, settings.delayRefresh)}
        ${createSlider("aeDelayDropdown", "Dropdown wait", 200, 8000, 100, settings.delayDropdown)}
        ${createSlider("aeDelaySelect", "Selection wait", 200, 8000, 100, settings.delaySelect)}
        ${createSlider("aeDelayContinue", "Continue → coords delay", 200, 8000, 100, settings.delayContinue || 2000)}
        ${createSlider("aeDelaySend", "Send fleet delay", 200, 8000, 100, settings.delaySend || 1500)}
        ${createSlider("aeRetryDelay", "Retry delay", 200, 8000, 100, settings.retryDelay)}
        </div>

        <button id="aeSettingsSave" class="ae-save">
        ${t("SAVE CONFIGURATION", "ENREGISTRER LA CONFIGURATION")}
        </button>
        </div>
        `;

        document.body.appendChild(modal);

        modal.querySelector("#aeFleetMode").value = settings.fleetMode;
        modal.querySelector("#aeFastMode").checked = !!settings.fastMode;
        modal.querySelector("#aeEscortShip").value = settings.escortShip || "battlecruiser";
        modal.querySelector("#aeLanguage").value = settings.language;
        modal.querySelector("#aeTheme").value = settings.theme;
        modal.querySelector("#aeLockType").value = settings.lockType || "moon";
        modal.querySelector("#aeLockGalaxy").value = settings.lockGalaxy || 4;
        modal.querySelector("#aeLockSystem").value = settings.lockSystem || 20;
        modal.querySelector("#aeLockPosition").value = settings.lockPosition || 15;

        ["aeDelayRefresh", "aeDelayDropdown", "aeDelaySelect", "aeDelayContinue", "aeDelaySend", "aeRetryDelay"].forEach(id => {
            const slider = modal.querySelector(`#${id}`);
            const value = modal.querySelector(`#${id}-val`);
            if (slider && value) {
                slider.addEventListener("input", () => {
                    value.textContent = `${slider.value}ms`;
                });
            }
        });

        ["aeDelayStart", "aeDelayBetween"].forEach(id => {
            const slider = modal.querySelector(`#${id}`);
            const value = modal.querySelector(`#${id}-val`);
            if (slider && value) {
                slider.addEventListener("input", () => {
                    value.textContent = formatDelayLabel(parseInt(slider.value, 10) || 0);
                });
            }
        });

        modal.querySelectorAll(".ae-set-tab").forEach(button => {
            button.addEventListener("click", () => {
                modal.querySelectorAll(".ae-set-tab").forEach(tab => tab.classList.remove("active"));
                modal.querySelectorAll(".ae-set-content").forEach(c => (c.style.display = "none"));
                button.classList.add("active");
                modal.querySelector(`#ae-set-${button.dataset.target}`).style.display = "block";
            });
        });

        modal.querySelector("#aeSettingsClose").addEventListener("click", () => modal.remove());

        modal.querySelector("#aeSettingsSave").addEventListener("click", () => {
            settings.fleetMode = modal.querySelector("#aeFleetMode").value;
            settings.fastMode = modal.querySelector("#aeFastMode").checked;
            settings.escortShip = modal.querySelector("#aeEscortShip").value || "battlecruiser";
            settings.language = modal.querySelector("#aeLanguage").value;
            settings.theme = modal.querySelector("#aeTheme").value;
            settings.humanize = modal.querySelector("#aeHumanize").checked;
            settings.notifications = modal.querySelector("#aeNotifications").checked;
            settings.lockType = modal.querySelector("#aeLockType").value;
            settings.lockGalaxy = parseInt(modal.querySelector("#aeLockGalaxy").value, 10) || 0;
            settings.lockSystem = parseInt(modal.querySelector("#aeLockSystem").value, 10) || 0;
            settings.lockPosition = parseInt(modal.querySelector("#aeLockPosition").value, 10) || 0;
            settings.delayRefresh = parseInt(modal.querySelector("#aeDelayRefresh").value, 10);
            settings.delayDropdown = parseInt(modal.querySelector("#aeDelayDropdown").value, 10);
            settings.delaySelect = parseInt(modal.querySelector("#aeDelaySelect").value, 10);
            settings.delayContinue = parseInt(modal.querySelector("#aeDelayContinue").value, 10);
            settings.delaySend = parseInt(modal.querySelector("#aeDelaySend").value, 10);
            settings.retryDelay = parseInt(modal.querySelector("#aeRetryDelay").value, 10);
            settings.delayStartMs = Math.max(0, Math.min(MAX_DELAY_MS, parseInt(modal.querySelector("#aeDelayStart").value, 10) || 0));
            settings.delayBetweenExpeditionsMs = Math.max(0, Math.min(MAX_DELAY_MS, parseInt(modal.querySelector("#aeDelayBetween").value, 10) || 0));
            // Clear old id lock so coords take priority on next run
            state.lockedPlanetId = null;
            state.lockedType = settings.lockType;
            state.lockedCoords = `${settings.lockGalaxy}:${settings.lockSystem}:${settings.lockPosition}`;
            saveState();
            saveSettings();
            modal.remove();
            rebuildPanel();
            log(
                t(
                    `Configuration updated.${settings.fastMode ? " Fast Mode ON." : ""}`,
                    `Configuration mise à jour.${settings.fastMode ? " Mode Rapide ON." : ""}`
                )
            );
        });
    }

    // ============================================================
    // PANEL
    // ============================================================

    function createPanel() {
        if (document.querySelector("#shuruknUltimateExpePanel")) return;

        panel = document.createElement("div");
        panel.id = "shuruknUltimateExpePanel";
        panel.innerHTML = `
        <div class="ae-header">
        <div class="ae-title">
        <span class="ae-drag-handle" title="Drag panel">🚀 Shurukn Ultimate Expedtions v${VERSION}</span>
        <div class="ae-controls">
        <span id="aeToggleMinimize" title="Minimize">_</span>
        <span id="aeGear" title="Settings">⚙</span>
        </div>
        </div>
        <div id="shuruknExpeStatus" class="ae-status">INITIALIZING</div>
        <div id="shuruknExpeStats" class="ae-stats">Cycles: 0 | Total Sent: 0</div>
        <div id="aeInfo" class="ae-info"></div>
        <div class="ae-hotkey">Ctrl + Alt + # ${t("to hide/show", "pour masquer/afficher")}</div>
        </div>
        <div id="aeCountdown" class="ae-countdown"></div>
        <div id="aeSteps" class="ae-steps"></div>
        <div id="shuruknExpeLog" class="ae-log"></div>
        <div class="ae-buttons">
        <button id="aePause" class="ae-btn ae-pause">⏸ ${t("PAUSE", "PAUSE")}</button>
        <button id="aePlay" class="ae-btn ae-play">▶ ${t("PLAY", "LECTURE")}</button>
        <button id="aePrevious" class="ae-btn ae-previous">◀ ${t("PREVIOUS", "PRÉCÉDENT")}</button>
        <button id="aeReset" class="ae-btn ae-reset">↻ ${t("RESET", "RÉINITIALISER")}</button>
        </div>
        `;

        document.body.appendChild(panel);

        statusElement = panel.querySelector("#shuruknExpeStatus");
        countdownElement = panel.querySelector("#aeCountdown");
        stepsElement = panel.querySelector("#aeSteps");
        logElement = panel.querySelector("#shuruknExpeLog");
        infoElement = panel.querySelector("#aeInfo");

        panel.querySelector("#aeToggleMinimize").addEventListener("click", toggleMinimize);
        panel.querySelector("#aeGear").addEventListener("click", openSettings);
        panel.querySelector("#aePause").addEventListener("click", pauseAutomation);
        panel.querySelector("#aePlay").addEventListener("click", playAutomation);
        panel.querySelector("#aePrevious").addEventListener("click", previousStep);
        panel.querySelector("#aeReset").addEventListener("click", resetAutomation);

        makeDraggable(panel, panel.querySelector(".ae-header"));

        if (settings.panelPosition) {
            panel.style.top = settings.panelPosition.top;
            panel.style.left = settings.panelPosition.left;
            panel.style.right = "auto";
            panel.style.bottom = "auto";
        }

        injectPanelCSS();
        applyMinimize();
        applyPanelVisibility();
        updatePanel();
    }

    function rebuildPanel() {
        if (panel) panel.remove();
        panel = null;
        createPanel();
    }

    function renderSteps() {
        if (!stepsElement) return;
        stepsElement.innerHTML = "";
        STEP_DEFINITIONS.forEach((step, index) => {
            const row = document.createElement("div");
            row.className = "ae-step";
            const status = state.stepStates[step.id] || "waiting";
            row.classList.add(status);
            const retry = state.stepRetries[step.id] || 0;
            let icon = "○";
            if (status === "processing") icon = "●";
            if (status === "success") icon = "✓";
            if (status === "failed") icon = "✕";
            row.innerHTML = `
            <span class="ae-step-number">${index + 1}</span>
            <span class="ae-step-icon">${icon}</span>
            <span class="ae-step-name">${stepName(step)}</span>
            <span class="ae-step-retry">${retry ? `[${retry}/${RETRY_COUNT}]` : ""}</span>
            `;
            stepsElement.appendChild(row);
        });
    }

    function updatePanel(message) {
        if (!panel) return;

        let statusText;
        if (state.recovery) statusText = t("RECOVERY", "RÉCUPÉRATION");
        else if (state.pendingStartUntil && Date.now() < state.pendingStartUntil) {
            statusText = t("START DELAY", "DÉLAI DÉMARRAGE");
        }
        else if (state.paused) statusText = t("PAUSED", "EN PAUSE");
        else if (state.active) {
            statusText = shouldUseFastMode()
                ? t("FAST MODE", "MODE RAPIDE")
                : t("RUNNING", "EN COURS");
        }
        else statusText = t("STOPPED", "ARRÊTÉ");

        const step = STEP_DEFINITIONS[state.currentStep];
        if (statusElement) {
            const stageLabel =
                state.pendingStartUntil && Date.now() < state.pendingStartUntil
                    ? formatDuration(state.pendingStartUntil - Date.now())
                    : step && !shouldUseFastMode()
                      ? stepName(step)
                      : currentStage;
            statusElement.textContent = `${statusText} | ${stageLabel}`;
        }

        const stats = panel.querySelector("#shuruknExpeStats");
        if (stats) {
            stats.textContent =
            `${t("Cycles", "Cycles")}: ${state.cycle} | ` +
            `${t("Total Sent", "Total envoyé")}: ${state.totalSent || 0}`;
        }

        if (infoElement) {
            const slots = state.lastSlots;
            const comp = state.lastFleetComposition;
            const origin =
            state.lockedCoords ||
            `${settings.lockGalaxy}:${settings.lockSystem}:${settings.lockPosition}`;
            const otype = state.lockedType || settings.lockType || "?";
            let info = `${otype} [${origin}]`;
            if (settings.fastMode) {
                info += isAdmiralActive()
                    ? t(" | FAST+ADM", " | RAPIDE+AMIRAL")
                    : t(" | FAST(no adm)", " | RAPIDE(sans amiral)");
            }
            if (slots) {
                info += ` | F:${slots.fleetUsed}/${slots.fleetTotal} E:${slots.expoUsed}/${slots.expoTotal}`;
            }
            if (comp && !shouldUseFastMode()) {
                const eKey = comp.escortShip || settings.escortShip || "battlecruiser";
                const eShort = eKey === "reaper" ? "RP" : eKey === "destroyer" ? "DE" : "BC";
                info += ` | SC:${comp.smallCargo} LC:${comp.largeCargo} PF:${comp.pathfinder} +P+${eShort}`;
            }
            infoElement.textContent = info;
        }

        renderSteps();
        updateCountdown();

        if (message && logElement) {
            const entry = document.createElement("div");
            entry.textContent = message;
            logElement.prepend(entry);
            while (logElement.children.length > 16) {
                logElement.lastElementChild.remove();
            }
        }
    }

    // ============================================================
    // CSS
    // ============================================================

    function injectPanelCSS() {
        const old = document.querySelector("#shuruknUltimateExpeStyle");
        if (old) old.remove();

        const dark = settings.theme === "dark";
        const bg = dark ? "rgba(12,17,26,.97)" : "rgba(248,250,252,.98)";
        const fg = dark ? "#f1f5f9" : "#0f172a";
        const border = dark ? "#334155" : "#cbd5e1";
        const header = dark
        ? "linear-gradient(90deg,#1e293b,#0f172a)"
        : "linear-gradient(90deg,#e2e8f0,#cbd5e1)";

        const style = document.createElement("style");
        style.id = "shuruknUltimateExpeStyle";
        style.textContent = `
        #shuruknUltimateExpePanel {
        position: fixed; z-index: 2147483647; right: 20px; top: 20px;
        width: 420px; background: ${bg}; color: ${fg};
        border: 1px solid ${border}; border-radius: 12px;
        font: 12px/1.4 'Segoe UI', Tahoma, monospace;
        box-shadow: 0 12px 45px rgba(0,0,0,.6); overflow: hidden;
        backdrop-filter: blur(10px);
        }
        .ae-minimized { width: 280px !important; }
        .ae-minimized #aeSteps,
        .ae-minimized #shuruknExpeLog,
        .ae-minimized .ae-buttons,
        .ae-minimized .ae-countdown { display: none !important; }
        .ae-header {
            padding: 12px 15px 9px; cursor: grab;
            background: ${header}; border-bottom: 1px solid ${border};
        }
        .ae-header:active { cursor: grabbing; }
        .ae-title {
            display: flex; justify-content: space-between; align-items: center;
            font-weight: 700; font-size: 14px;
        }
        .ae-drag-handle {
            flex: 1; color: ${dark ? "#38bdf8" : "#0284c7"}; pointer-events: none;
        }
        .ae-controls { display: flex; gap: 8px; }
        .ae-controls span {
            cursor: pointer; padding: 2px 7px; border-radius: 5px;
            background: rgba(128,128,128,.15); transition: .18s ease;
        }
        .ae-controls span:hover { background: rgba(255,255,255,.22); transform: scale(1.08); }
        .ae-controls span:active { transform: scale(.92); }
        .ae-status { margin-top: 7px; font-weight: 800; font-size: 11px; }
        .ae-stats { margin-top: 2px; opacity: .7; font-size: 10px; }
        .ae-info { margin-top: 2px; opacity: .85; font-size: 10px; color: ${dark ? "#94a3b8" : "#475569"}; }
        .ae-hotkey { margin-top: 4px; opacity: .45; font-size: 9px; }
        .ae-countdown {
            margin: 9px 12px; padding: 11px; text-align: center; white-space: pre-line;
            border-radius: 7px; background: rgba(220,38,38,.14);
            border: 1px solid rgba(239,68,68,.35); color: #ef4444;
            font-weight: 800; font-size: 13px; letter-spacing: .3px;
        }
        .ae-steps { padding: 9px 12px; }
        .ae-step {
            display: flex; align-items: center; gap: 8px; margin: 4px 0;
            padding: 7px 8px; border-radius: 6px; transition: all .2s ease;
            font-size: 11.5px; border: 1px solid transparent;
        }
        .ae-step.waiting { background: #2563eb; color: #fff; opacity: .65; }
        .ae-step.processing {
            background: #eab308; color: #111827; font-weight: 800;
            transform: translateX(4px); box-shadow: 0 0 10px rgba(234,179,8,.3);
        }
        .ae-step.success { background: #16a34a; color: #fff; font-weight: 700; }
        .ae-step.failed {
            background: #dc2626; color: #fff; font-weight: 800;
            box-shadow: 0 0 10px rgba(220,38,38,.3);
        }
        .ae-step-number { width: 18px; text-align: right; opacity: .65; }
        .ae-step-icon { width: 17px; text-align: center; font-weight: 900; }
        .ae-step-name { flex: 1; }
        .ae-step-retry { font-size: 9px; opacity: .8; }
        .ae-log {
            margin: 0 12px 10px; padding: 8px; max-height: 130px; overflow-y: auto;
            border-top: 1px dashed ${border}; color: ${dark ? "#94a3b8" : "#64748b"};
            font-size: 10px; white-space: pre-wrap; line-height: 1.5;
        }
        .ae-buttons {
            display: grid; grid-template-columns: 1fr 1fr; gap: 8px; padding: 0 12px 12px;
        }
        .ae-btn {
            border: none; border-radius: 6px; padding: 10px; cursor: pointer; color: #fff;
            font-weight: 800; text-transform: uppercase; letter-spacing: .5px;
            transition: all .16s ease; box-shadow: 0 2px 5px rgba(0,0,0,.25);
        }
        .ae-btn:hover { filter: brightness(1.18); transform: translateY(-2px); box-shadow: 0 4px 10px rgba(0,0,0,.35); }
        .ae-btn:active { transform: translateY(1px) scale(.98); filter: brightness(.9); }
        .ae-pause { background: #d97706; }
        .ae-play { background: #16a34a; }
        .ae-previous { background: #0284c7; }
        .ae-reset { background: #dc2626; }
        #shuruknUltimateExpeSettings {
        position: fixed; inset: 0; z-index: 2147483646; background: rgba(0,0,0,.72);
        display: flex; align-items: center; justify-content: center; backdrop-filter: blur(4px);
        }
        .ae-settings-window {
            width: 440px; max-height: 90vh; overflow-y: auto; padding: 20px; border-radius: 12px;
            background: ${dark ? "#1e293b" : "#ffffff"}; color: ${dark ? "#f8fafc" : "#0f172a"};
            box-shadow: 0 20px 50px rgba(0,0,0,.55); border: 1px solid ${border};
        }
        .ae-settings-title {
            display: flex; justify-content: space-between; align-items: center;
            font-size: 16px; font-weight: 800; padding-bottom: 10px; margin-bottom: 15px;
            border-bottom: 1px solid ${border};
        }
        .ae-close { background: none; border: none; color: inherit; font-size: 25px; cursor: pointer; }
        .ae-settings-tabs { display: flex; gap: 8px; margin-bottom: 15px; }
        .ae-set-tab {
            flex: 1; padding: 8px; background: ${dark ? "#0f172a" : "#f1f5f9"}; color: inherit;
            border: 1px solid ${border}; border-radius: 6px; cursor: pointer; font-weight: 700;
        }
        .ae-set-tab:hover { filter: brightness(1.1); }
        .ae-set-tab.active { background: #0284c7; color: white; border-color: #0284c7; }
        .ae-setting-row {
            display: grid; grid-template-columns: 155px 1fr; align-items: center;
            gap: 10px; margin-bottom: 13px; font-size: 12px;
        }
        .ae-setting-row select {
            width: 100%; padding: 7px; border-radius: 5px;
            background: ${dark ? "#0f172a" : "#f8fafc"}; color: inherit; border: 1px solid ${border};
        }
        .ae-setting-row input[type="checkbox"] { width: auto; transform: scale(1.2); }
        .ae-slider-row { display: block; }
        .ae-slider-row label { display: flex; justify-content: space-between; margin-bottom: 6px; }
        .ae-slider-row strong { color: #38bdf8; }
        .ae-save {
            width: 100%; padding: 12px; margin-top: 10px; background: #16a34a; color: white;
            font-weight: 800; border: none; border-radius: 6px; cursor: pointer; transition: .18s;
        }
        .ae-save:hover { background: #15803d; transform: translateY(-1px); }
        .ae-save:active { transform: translateY(1px); }
        `;
        document.head.appendChild(style);
    }

    // ============================================================
    // STARTUP
    // ============================================================

    function startup() {
        normalizeState();
        createPanel();

        log(t(`Shurukn Ultimate Expedtions v${VERSION} loaded.`, `Shurukn Ultimate Expedtions v${VERSION} chargé.`));

        if (state.recovery) {
            log(
                t(
                    "Persistent recovery detected. Countdown resumed.",
                    "Récupération persistante détectée. Compte à rebours repris."
                ),
                "WARN"
            );
            startCountdownTimer();
            runRecovery();
            startKeepAlive();
            return;
        }

        if (state.active) {
            if (state.paused) {
                log(t("Automation is paused. Press PLAY.", "Automatisation en pause. Appuyez sur LECTURE."), "WARN");
                startKeepAlive();
                return;
            }
            if (state.pendingStartUntil && Date.now() < state.pendingStartUntil) {
                log(t("Resuming delayed start countdown.", "Reprise du compte à rebours de démarrage différé."));
                runDelayedStart();
                startKeepAlive();
                return;
            }
            state.pendingStartUntil = 0;
            executeFleetSequence();
            startKeepAlive();
            return;
        }

        log(t("Ready. Press PLAY to start.", "Prêt. Appuyez sur LECTURE pour démarrer."));
        if (settings.fastMode) {
            log(
                isAdmiralActive()
                    ? t("Fast Mode enabled — Admiral active.", "Mode Rapide activé — Amiral actif.")
                    : t("Fast Mode enabled but Admiral inactive (will fall back).", "Mode Rapide activé mais Amiral inactif (secours classique)."),
                isAdmiralActive() ? "INFO" : "WARN"
            );
        }
        startKeepAlive();
    }

    /**
     * Lightweight keep-alive: while the tab is open and automation is active,
     * periodically ensure the sequence or recovery is still progressing.
     * Prevents silent stalls after soft navigations or long idle periods.
     */
    let keepAliveTimer = null;
    function startKeepAlive() {
        if (keepAliveTimer) return;
        keepAliveTimer = setInterval(() => {
            if (!state.active) return;
            if (state.paused && !state.recovery) return;
            if (state.pendingStartUntil && Date.now() < state.pendingStartUntil) {
                if (!delayedStartRunning) runDelayedStart();
                return;
            }
            if (state.recovery) {
                if (!recoveryRunning) runRecovery();
                return;
            }
            if (!sequenceRunning) {
                log(t("Keep-alive: resuming sequence.", "Keep-alive : reprise de la séquence."), "WARN");
                executeFleetSequence();
            }
        }, 30000); // every 30s — tighter for ASAP loops
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", startup, { once: true });
    } else {
        startup();
    }
})();

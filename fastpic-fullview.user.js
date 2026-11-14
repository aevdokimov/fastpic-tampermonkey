// ==UserScript==
// @name         FastPic — сразу полное изображение
// @name:en      FastPic — open the full-size image immediately
// @namespace    https://github.com/aevdokimov/fastpic-tampermonkey
// @version      1.0.0
// @description  Пропускает страницы /view/ и /fullview/ и сразу открывает оригинал изображения на iN.fastpic.org
// @author       aevdokimov
// @license      MIT
// @match        https://fastpic.org/view/*
// @match        https://fastpic.org/fullview/*
// @match        http://fastpic.org/view/*
// @match        http://fastpic.org/fullview/*
// @run-at       document-start
// @noframes
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    /* ------------------------------- настройки ------------------------------ */

    const CFG = {
        // Сколько ждать ответ /fullview/ (мс). По истечении страница остаётся как есть.
        TIMEOUT_MS: 12000,
        // Прятать страницу, пока ищем финальный URL (чтобы не мигала реклама).
        HIDE_WHILE_RESOLVING: true,
        // true  — открыть картинку в новой вкладке (текущая останется на fastpic);
        // false — открыть картинку вместо страницы fastpic (поведение по умолчанию).
        OPEN_IN_NEW_TAB: false,
        // Максимум переходов по ссылке антибот-заглушки (защита от зацикливания).
        MAX_NAVIGATION_ATTEMPTS: 2,
        // Подробный лог в консоль.
        DEBUG: false
    };

    /* -------------------------------- утилиты ------------------------------- */

    const TAG = '[fastpic-full]';
    const log = (...args) => { if (CFG.DEBUG) console.log(TAG, ...args); };
    const warn = (...args) => { if (CFG.DEBUG) console.warn(TAG, ...args); };

    const path = location.pathname;

    // Работаем только на страницах просмотра.
    if (!/^\/(?:view|fullview)\//.test(path)) return;

    // "…/8cd3eda0728594e54e142e9885a8a7b0.jpg.html" -> "8cd3eda0728594e54e142e9885a8a7b0.jpg"
    const fileName = (path.match(/\/([^/]+?)\.html?$/i) || [])[1] || '';
    // "…/129/2026/1111/…" -> "2026/1111" (дополнительный признак «нашего» файла)
    const datePath = (path.match(/\/(\d{4}\/\d{4})\//) || [])[1] || '';

    // ?info=1 — кнопка «Показать сведения о файле»: это осознанное действие, не мешаем.
    let params = null;
    try { params = new URLSearchParams(location.search || ''); } catch (e) { params = null; }
    if (params && params.has('info')) return;

    const attemptsKey = 'fpfull:nav:' + path;
    let finished = false;
    let veilTimer = 0;

    /* --------------------------------- завеса -------------------------------- */

    const veil = {
        on() {
            if (!CFG.HIDE_WHILE_RESOLVING) return;
            const apply = () => {
                const root = document.documentElement;
                if (!root || !root.style) return false;
                root.style.setProperty('visibility', 'hidden', 'important');
                return true;
            };
            if (apply()) return;
            // document-start: <html> ещё не создан — ждём его появления.
            veilTimer = setInterval(() => { if (apply()) clearInterval(veilTimer); }, 10);
            setTimeout(() => clearInterval(veilTimer), 5000);
        },
        off() {
            clearInterval(veilTimer);
            const root = document.documentElement;
            if (root && root.style) root.style.removeProperty('visibility');
        }
    };

    /* ------------------------------ нормализация ----------------------------- */

    function cleanUrl(raw) {
        if (!raw) return null;
        let value = String(raw).replace(/&amp;/g, '&').trim();
        if (value.startsWith('//')) value = location.protocol + value;
        let url;
        try { url = new URL(value, location.href); } catch (e) { return null; }
        // &dl=1 заставляет браузер скачать файл вместо показа — для просмотра не нужен.
        url.searchParams.delete('dl');
        return url.href;
    }

    function isBig(url) {
        if (!url || !/^https?:\/\/i\d+\.fastpic\.org\/big\//i.test(url)) return false;
        // Фильтр от рекламных «двойников» вида https://i114.fastpic.org/big/…/f00dd….jpeg,
        // которые fastpic подмешивает в CSS/пиксели страницы.
        if (fileName && url.indexOf(fileName) === -1) return false;
        if (datePath && url.indexOf(datePath) === -1) return false;
        return true;
    }

    /* ------------------------------ переход ---------------------------------- */

    function go(raw) {
        const url = cleanUrl(raw);
        if (!isBig(url)) { warn('отклонён URL:', raw); return false; }
        if (finished) return true;
        finished = true;
        log('открываю', url);
        if (CFG.OPEN_IN_NEW_TAB) {
            window.open(url, '_blank', 'noopener');
            veil.off();
            return true;
        }
        location.replace(url);
        return true;
    }

    /* --------------------------- разбор HTML / DOM --------------------------- */

    // На /fullview/ финальный URL объявлен в inline-скрипте:
    //   var loading_img = 'https://i129.fastpic.org/big/2026/1111/b0/…?md5=…&expires=…';
    const LOADING_RE = /loading_img\s*=\s*(['"])([^'"]+)\1/;
    const BIG_URL_RE = /https?:\/\/i\d+\.fastpic\.org\/big\/[^\s"'<>\\]+/gi;

    function extractFromHtml(html) {
        if (!html) return null;
        if (html.length < 200) {
            // fastpic умеет отвечать «заглушкой» (например, один символ «-» на запросы
            // с подозрительным User-Agent) — разбирать там нечего.
            warn('ответ подозрительно короткий:', html.length, 'байт');
            return null;
        }

        const m = html.match(LOADING_RE);
        if (m) {
            const url = cleanUrl(m[2]);
            if (isBig(url)) return url;
            warn('loading_img не похож на оригинал:', m[2]);
        }

        // Фолбэк: ссылки на /big/ из разметки («Открыть картинку в браузере», <img class="image">).
        const found = html.match(BIG_URL_RE) || [];
        for (const raw of found) {
            const url = cleanUrl(raw);
            if (isBig(url)) return url;
        }
        return null;
    }

    function extractFromDom() {
        const nodes = document.querySelectorAll('a[href], img[src]');
        for (const node of nodes) {
            const raw = node.getAttribute('href') || node.getAttribute('src');
            const url = cleanUrl(raw);
            if (isBig(url)) return url;
        }
        return null;
    }

    /* --------------------- антибот-заглушка «Перейти к изображению» ---------- */

    function findInterstitialHref() {
        const anchors = document.querySelectorAll('a[href]');
        for (const a of anchors) {
            const href = a.getAttribute('href') || '';
            if (!href || href.indexOf('/view/') === -1) continue;
            if (fileName && href.indexOf(fileName) === -1) continue;

            let url;
            try { url = new URL(href, location.origin); } catch (e) { continue; }

            // Та же страница, но с непустым query-параметром-токеном (?p5cb90=6c688338a1).
            if (url.pathname !== path) continue;
            const keys = [];
            url.searchParams.forEach((_value, key) => { if (key !== 'lang') keys.push(key); });
            if (keys.length) return url.href;
        }
        return null;
    }

    function hop() {
        let attempts = 0;
        try { attempts = parseInt(sessionStorage.getItem(attemptsKey) || '0', 10) || 0; } catch (e) { /* ignore */ }
        if (attempts >= CFG.MAX_NAVIGATION_ATTEMPTS) return false;

        const href = findInterstitialHref();
        if (!href) return false;

        try { sessionStorage.setItem(attemptsKey, String(attempts + 1)); } catch (e) { /* ignore */ }
        log('перехожу по ссылке-заглушке', href);
        location.replace(href);
        return true;
    }

    /* -------------------------------- сеть ----------------------------------- */

    async function fetchHtml(url) {
        const init = { credentials: 'same-origin', redirect: 'follow' };
        if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) {
            init.signal = AbortSignal.timeout(CFG.TIMEOUT_MS);
        }
        let res;
        try {
            res = await fetch(url, init);
        } catch (err) {
            // Не все окружения переваривают все опции — повторяем «налегке»,
            // но таймаут не повторяем (иначе ожидание удвоится).
            if (err && (err.name === 'AbortError' || err.name === 'TimeoutError')) throw err;
            res = await fetch(url);
        }
        if (!res.ok) throw new Error('HTTP ' + res.status + ' для ' + url);
        return await res.text();
    }

    // Фолбэки по DOM имеют смысл только когда документ уже разобран.
    async function waitForDom(maxMs = 3000) {
        if (document.readyState !== 'loading') return;
        await new Promise((resolve) => {
            let timer = 0;
            const done = () => {
                clearTimeout(timer);
                document.removeEventListener('DOMContentLoaded', done);
                resolve();
            };
            document.addEventListener('DOMContentLoaded', done);
            timer = setTimeout(done, maxMs);
        });
    }

    /* ------------------------------- основной -------------------------------- */

    async function resolve() {
        veil.on();

        // /view/…html -> /fullview/…html; query (в т.ч. антибот-токен) и hash отбрасываем.
        const fullviewUrl = location.origin + path.replace(/^\/(?:view|fullview)\//, '/fullview/');

        try {
            // Главный путь: страница /fullview/ отдаётся напрямую — без cookie, referer и токена,
            // и содержит подписанный URL оригинала.
            const html = await fetchHtml(fullviewUrl);
            const url = extractFromHtml(html);
            if (url && go(url)) return;
            warn('на странице нет loading_img:', fullviewUrl);
        } catch (err) {
            warn('не удалось получить', fullviewUrl, err);
        }

        // Фолбэк 1: прямая ссылка уже есть в DOM (настоящая /view/ или /fullview/).
        await waitForDom();
        const fromDom = extractFromDom();
        if (fromDom && go(fromDom)) return;

        // Фолбэк 2: один раз идём по ссылке антибот-заглушки — тогда следующий запуск
        // скрипта сработает уже на настоящей странице просмотра.
        if (hop()) return;

        // Ничего не вышло — показываем страницу как есть.
        veil.off();
    }

    resolve().catch((err) => {
        warn('непредвиденная ошибка', err);
        veil.off();
    });
})();


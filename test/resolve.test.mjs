/**
 * Живой тест юзерскрипта: запускает НАСТОЯЩИЙ код fastpic-fullview.user.js
 * в песочнице node:vm с моками браузерного окружения и реальным fetch.
 *
 * Проверяем не «свой регэксп», а поведение скрипта: куда он редиректит
 * (или не редиректит) при открытии конкретных страниц fastpic.org.
 *
 * Запуск: npm test
 */

import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const SCRIPT_URL = new URL('../fastpic-fullview.user.js', import.meta.url);
const META_RE = /^\s*\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==\s*/;

// Рекламный «двойник», который fastpic подмешивает в CSS/пиксели страниц.
const AD_DECOY = 'f00dadd78abb215662617bd877f98ca3';

const IMG_A = '8cd3eda0728594e54e142e9885a8a7b0.jpg';
const IMG_B = '_5e69e4ad6abf139e4f08c1b6fce03014.png';
const IMG_GONE = 'b76cbcf2d183ae34ee207bacaecd3312.jpg';

const URL_A = `https://fastpic.org/view/129/2026/1111/${IMG_A}.html`;
const URL_B = `https://fastpic.org/view/123/2024/0828/${IMG_B}.html`;
const URL_GONE = `https://fastpic.org/view/112/2019/0121/${IMG_GONE}.html`;

/* ------------------------------ песочница ------------------------------- */

function stripMeta(source) {
    return source.replace(META_RE, '');
}

function createEnv(href, { fetchImpl } = {}) {
    const target = new URL(href);
    const state = { redirects: [], fetchCalls: 0 };

    let settle;
    let settled = false;
    const finished = new Promise((resolve) => {
        settle = (value) => {
            if (settled) return;
            settled = true;
            resolve(value);
        };
    });

    const location = {
        href: target.href,
        origin: target.origin,
        protocol: target.protocol,
        hostname: target.hostname,
        pathname: target.pathname,
        search: target.search,
        hash: target.hash,
        replace(url) {
            state.redirects.push(String(url));
            settle(String(url));
        },
        assign(url) {
            this.replace(url);
        }
    };

    const style = {
        setProperty() {},
        // Скрипт снимает «завесу» только если никуда не ушёл — это и есть сигнал «готово».
        removeProperty() {
            settle(null);
        }
    };

    const document = {
        documentElement: { style },
        readyState: 'complete',
        querySelectorAll: () => [],
        querySelector: () => null,
        addEventListener() {},
        removeEventListener() {}
    };

    const store = new Map();
    const sessionStorage = {
        getItem: (key) => (store.has(key) ? store.get(key) : null),
        setItem: (key, value) => { store.set(key, String(value)); },
        removeItem: (key) => { store.delete(key); }
    };

    const sandbox = {
        location,
        document,
        sessionStorage,
        window: {},
        URL,
        URLSearchParams,
        AbortSignal,
        fetch: (...args) => {
            state.fetchCalls += 1;
            return fetchImpl(...args);
        },
        setTimeout: (fn, ms) => {
            const timer = setTimeout(fn, ms);
            if (timer.unref) timer.unref();
            return timer;
        },
        clearTimeout,
        setInterval: (fn, ms) => {
            const timer = setInterval(fn, ms);
            if (timer.unref) timer.unref();
            return timer;
        },
        clearInterval,
        console: { log() {}, warn() {}, error: (...a) => console.error(...a) }
    };

    return { context: vm.createContext(sandbox), state, finished };
}

function withTimeout(promise, ms) {
    let timer;
    const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve('__timeout__'), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function runCase(href, options = {}) {
    const source = stripMeta(await readFile(SCRIPT_URL, 'utf8'));
    const impl = options.fetchImpl || ((...args) => fetch(...args));
    const env = createEnv(href, { fetchImpl: impl });
    vm.runInContext(source, env.context, { filename: 'fastpic-fullview.user.js' });

    const target = await withTimeout(env.finished, options.waitMs ?? 20000);
    return { target, state: env.state };
}

/* -------------------------------- тесты --------------------------------- */

const results = [];

async function test(name, fn) {
    try {
        await fn();
        results.push({ name, ok: true });
        console.log(`  ok   ${name}`);
    } catch (err) {
        results.push({ name, ok: false, err });
        console.log(`  FAIL ${name}\n       ${String(err && err.message).split('\n').join('\n       ')}`);
    }
}

async function assertImageServes(url) {
    const res = await fetch(url, { method: 'HEAD' });
    assert.equal(res.status, 200, `оригинал должен отдаваться, получен HTTP ${res.status}`);
    assert.match(res.headers.get('content-type') || '', /^image\//, 'content-type должен быть image/*');
}

console.log('\nFastPic userscript — живые тесты\n');

await test('свежее изображение: /view/ -> оригинал', async () => {
    const { target, state } = await runCase(URL_A);

    assert.equal(state.redirects.length, 1, 'должен быть ровно один редирект');
    assert.match(target, /^https:\/\/i129\.fastpic\.org\/big\/2026\/1111\/b0\/8cd3eda0728594e54e142e9885a8a7b0\.jpg\?md5=[\w-]+&expires=\d+$/);
    assert.ok(!target.includes(AD_DECOY), 'не должен попасть на рекламную подделку');
    assert.ok(!target.includes('dl=1'), 'dl=1 заставил бы браузер скачать файл');
    await assertImageServes(target);
});

await test('старое изображение (.png, 2024): /view/ -> оригинал', async () => {
    const { target, state } = await runCase(URL_B);

    assert.equal(state.redirects.length, 1);
    assert.match(target, /^https:\/\/i123\.fastpic\.org\/big\/2024\/0828\/14\/_5e69e4ad6abf139e4f08c1b6fce03014\.png\?md5=[\w-]+&expires=\d+$/);
    assert.ok(!target.includes(AD_DECOY));
    await assertImageServes(target);
});

await test('удалённое изображение: редиректа нет, страница остаётся', async () => {
    const { target, state } = await runCase(URL_GONE);

    assert.equal(state.redirects.length, 0, 'редирект не нужен');
    assert.equal(target, null, 'скрипт должен снять «завесу» и отдать страницу как есть');
});

await test('?info=1 (сведения о файле): скрипт не вмешивается', async () => {
    const { target, state } = await runCase(`${URL_A}?info=1`, { waitMs: 400 });

    assert.equal(state.redirects.length, 0);
    assert.equal(state.fetchCalls, 0, 'не должно быть ни одного запроса');
    assert.equal(target, '__timeout__');
});

await test('сеть недоступна: редиректа нет, страница остаётся', async () => {
    const { target, state } = await runCase(URL_A, {
        fetchImpl: () => Promise.reject(new TypeError('offline'))
    });

    assert.equal(state.redirects.length, 0);
    assert.equal(target, null);
});

/* -------------------------------- итог ---------------------------------- */

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} тестов прошло\n`);
if (failed.length) process.exitCode = 1;


#!/usr/bin/env node
/**
 * 清华大学网络学堂（learn.tsinghua.edu.cn）自动打开 + 自动登录
 *
 * 工作原理（与网站实际登录流程一致）：
 *   1. 用一个独立的 Edge 窗口（自己的配置，不碰你平时的浏览器）打开网络学堂；
 *      之所以要独立窗口：Edge 只有在「启动时就带调试端口」时才能被程序接管，
 *      而你平时那个 Edge 往往已经开着，程序接管不了它；
 *   2. 未登录时会被转到网络学堂登录页，程序自动点「登录」，跳到
 *      清华统一身份认证系统 id.tsinghua.edu.cn；
 *   3. 在认证页把账号填进用户名框、密码填进密码框，然后调用该网页
 *      自己的 doLogin() 提交（密码由网页用国密 SM2 加密后再发送，
 *      程序不接触加密细节，也不做任何绕过）；
 *   4. 登录成功由认证系统跳回网络学堂，最后停在你要的课程页面。
 *
 * 特点：不需要安装任何第三方库（只用 Node 内置能力），也不依赖 Python。
 *
 * 账号密码怎么来：
 *   第一次运行时会在终端窗口里让你输一次（密码显示为 *），然后加密保存在
 *   本机（credentials.dat，用 Windows 自带的 DPAPI 加密，只有这台电脑的
 *   这个用户能解开）；以后运行直接读它，不再询问。
 *   想改用明文文件，用 --creds 指定即可。
 *
 * 用法：
 *   node tsinghua-learn-autologin.mjs
 *   node tsinghua-learn-autologin.mjs --creds D:\某个文件.txt
 *   node tsinghua-learn-autologin.mjs --dry-run        （只填表不提交，用于自检）
 *
 * 参数：
 *   --creds  <文件>   指定明文账号文件（一般不用，默认走上面的加密保存）
 *   --site   <网址>   登录后要停留的页面，默认学生课程页
 *   --profile <目录>  独立窗口的配置存放位置（默认放在
 *                     %LOCALAPPDATA%\tsinghua-learn-autologin\browser-profile，
 *                     刻意不放在程序目录里，免得把程序目录塞满；
 *                     不要指向你平时 Edge 的配置目录）
 *   --copy-profile    首次运行时，把你平时 Edge 的书签、图标复制过来
 *                     （登录状态只有在 Edge 完全关闭时才可能复制成功）
 *   --port   <端口>   本机调试端口，默认 9333
 *   --timeout <秒>    等待登录完成的最长时间，默认 300
 *   --trust-browser   勾选「信任浏览器（统一登录）」，之后一段时间内免密登录
 *   --dry-run         只打开页面并填好账号密码，不点提交
 *   -h, --help        显示帮助
 *
 * 说明：独立窗口第一次运行需要登录一次，之后登录状态存在它自己的配置里，
 * 只要那个窗口还开着、或会话还没过期，直接在它里面继续用即可。
 * 你平时那个 Edge 完全不受影响，程序不会去动它。
 */

import { spawn } from 'node:child_process';
import { cp, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// 独立窗口的配置目录：放在用户的应用数据目录里，不放程序目录，
// 免得浏览器那几十兆缓存把 outputs 之类的交付目录塞满。
function defaultProfileDir() {
  const base = process.env.LOCALAPPDATA || process.env.APPDATA || os.tmpdir();
  return path.join(base, 'tsinghua-learn-autologin', 'browser-profile');
}

const DEFAULTS = {
  site: 'https://learn.tsinghua.edu.cn/f/wlxt/index/course/student/',
  ssoFallback:
    'https://id.tsinghua.edu.cn/do/off/ui/auth/login/form/bb5df85216504820be7bba2b0ae1535b/0',
  profile: defaultProfileDir(),
  port: 9333,
  timeoutSec: 300,
};

/** 你平时那个 Edge 的配置目录 */
function edgeUserDataDir() {
  const base = process.env.LOCALAPPDATA || process.env.APPDATA;
  return base ? path.join(base, 'Microsoft', 'Edge', 'User Data') : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);
const warn = (...a) => console.log('  ! ' + a.join(' '));

/** 日志里不写完整的学号/工号，遮一下 */
function maskAccount(s) {
  const t = String(s || '');
  if (!t) return '';
  if (t.length <= 4) return t[0] + '*'.repeat(Math.max(1, t.length - 1));
  return t.slice(0, 3) + '*'.repeat(t.length - 5) + t.slice(-2);
}

// --------------------------------------------------------------------------
// 命令行参数
// --------------------------------------------------------------------------
function parseArgs(argv) {
  const o = {
    ...DEFAULTS,
    creds: null,
    dryRun: false,
    trustBrowser: false,
    copyProfile: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const need = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`参数 ${a} 后面缺少数值`);
      return v;
    };
    if (a === '--creds' || a === '-c') o.creds = need();
    else if (a === '--site' || a === '-s') o.site = need();
    else if (a === '--profile') o.profile = need();
    else if (a === '--port') o.port = Number(need());
    else if (a === '--timeout') o.timeoutSec = Number(need());
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--trust-browser') o.trustBrowser = true;
    else if (a === '--copy-profile') o.copyProfile = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else throw new Error(`无法识别的参数：${a}（用 -h 看帮助）`);
  }
  if (!Number.isInteger(o.port) || o.port < 1 || o.port > 65535) {
    throw new Error(`--port 必须是 1-65535 之间的整数（现在给的是 ${o.port}）`);
  }
  if (!Number.isFinite(o.timeoutSec) || o.timeoutSec <= 0 || o.timeoutSec > 3600) {
    throw new Error(`--timeout 必须是 1-3600 之间的秒数（现在给的是 ${o.timeoutSec}）`);
  }
  let site;
  try {
    site = new URL(o.site);
  } catch {
    throw new Error(
      `--site 不是合法的网址：${o.site}\n` +
        '  例如：--site https://learn.tsinghua.edu.cn/',
    );
  }
  if (site.protocol !== 'http:' && site.protocol !== 'https:') {
    throw new Error(`--site 只支持 http/https 网址（现在给的是 ${o.site}）`);
  }
  o.site = site.href;
  return o;
}

function printHelp() {
  log(
    [
      '',
      '清华大学网络学堂 自动登录程序',
      '',
      '  node tsinghua-learn-autologin.mjs [选项]',
      '',
      '  --creds   <文件>   指定明文账号文件（一般不用，默认用加密保存的账号）',
      '  --site    <网址>   登录后停留的页面（默认学生课程页）',
      '  --profile <目录>   独立窗口的配置存放位置',
      '                     （默认 %LOCALAPPDATA%\\tsinghua-learn-autologin\\browser-profile）',
      '                     不要指向你平时 Edge 的配置目录',
      '  --copy-profile     首次运行时复制你平时 Edge 的书签和图标',
      '                     （不复制保存的密码和历史记录；登录状态只有在',
      '                     Edge 完全关闭时才可能复制成功）',
      '  --port    <端口>   本机调试端口（默认 9333）',
      '  --timeout <秒>     等待登录完成的最长时间（默认 300）',
      '  --trust-browser    勾选「信任浏览器（统一登录）」，之后一段时间内免密登录',
      '  --dry-run          只打开页面并填好账号密码，不提交',
      '  -h, --help         显示本帮助',
      '',
      '账号密码：',
      '  第一次运行会在终端窗口里让你输入一次（密码显示为 *），之后加密保存在本机',
      '  （credentials.dat，用 Windows DPAPI 加密，只有这台电脑的这个用户能解开），',
      '  以后再运行就直接读取，不再询问。',
      '  账号密码被认证系统拒绝时，保存的账号会被删掉，下次运行重新问你。',
      '  想改用明文文件：加 --creds 路径，文件里写两行「账号=...」「密码=...」。',
      '',
    ].join('\n'),
  );
}

// --------------------------------------------------------------------------
// 读取账号密码文件
// --------------------------------------------------------------------------
const USER_KEYS = ['账号', '帐号', '用户名', '学号', 'username', 'user', 'account', 'login'];
const PASS_KEYS = ['密码', 'password', 'pass', 'pwd'];

/**
 * 读文本并自动判断编码。
 * 中文 Windows 上旧版记事本默认存成 GBK，按 UTF-8 读会得到一串替换字符，
 * 中文键名就匹配不上了，所以这里检测到就再按 GBK 解一次。
 */
function decodeText(buf) {
  const utf8 = buf.toString('utf8');
  if (!utf8.includes('\uFFFD')) return { text: utf8, encoding: 'utf-8' };
  try {
    const gbk = new TextDecoder('gbk').decode(buf);
    if (!gbk.includes('\uFFFD')) return { text: gbk, encoding: 'gbk' };
  } catch {
    /* 当前 Node 没带 GBK 解码表，走下面的兜底提示 */
  }
  return { text: utf8, encoding: 'unknown', garbled: true };
}

async function readCredentials(file) {
  let buf;
  try {
    buf = await readFile(file);
  } catch {
    throw new Error(`读不到账号密码文件：${file}`);
  }
  const decoded = decodeText(buf);
  const text = decoded.text.replace(/^\uFEFF/, '');
  if (!text.trim()) throw new Error(`账号密码文件是空的：${file}`);

  let username = '';
  let password = '';

  if (text.trimStart().startsWith('{')) {
    let obj;
    try {
      obj = JSON.parse(text);
    } catch (e) {
      throw new Error(`账号密码文件不是合法 JSON：${e.message}`);
    }
    const pick = (keys) => {
      for (const k of Object.keys(obj)) {
        if (keys.includes(String(k).trim().toLowerCase())) return String(obj[k]);
      }
      return '';
    };
    username = pick(USER_KEYS);
    password = pick(PASS_KEYS);
  } else {
    const map = new Map();
    for (const line of text.split(/\r?\n/)) {
      const s = line.trim();
      if (!s || s.startsWith('#') || s.startsWith('//')) continue;
      const m = s.match(/^([^=:：]{1,24})\s*[=:：]\s*(.*)$/);
      if (!m) continue;
      const key = m[1].trim().toLowerCase();
      if (!map.has(key)) map.set(key, m[2]);
    }
    const pick = (keys) => {
      for (const k of keys) if (map.has(k) && map.get(k).trim()) return map.get(k).trim();
      return '';
    };
    username = pick(USER_KEYS);
    password = pick(PASS_KEYS);
  }

  if (!username || !password) {
    throw new Error(
      `账号密码文件缺少内容：${file}\n` +
        (decoded.garbled
          ? '  这个文件看起来不是 UTF-8 编码（多半是记事本存成了 ANSI/GBK）。\n' +
            '  请用记事本打开，选「另存为」并把编码改成 UTF-8 后重试。\n'
          : '') +
        '  请写成下面两行（等号两边不要加引号）：\n' +
        '    账号=你的学号\n' +
        '    密码=你的密码',
    );
  }
  return { username, password, file, encoding: decoded.encoding };
}

// --------------------------------------------------------------------------
// 账号密码的本地加密保存
// 用 Windows 自带的 DPAPI（由 credential-store.ps1 调系统接口）：
// 密钥由系统按"本机 + 当前用户"保管，文件被拷到别的电脑或别的用户下都解不开。
// --------------------------------------------------------------------------
const PS_HELPER = path.join(HERE, 'credential-store.ps1');
const CRED_STORE = path.join(HERE, 'credentials.dat');

/** 调一次 credential-store.ps1；input 会作为标准输入传进去 */
function psCall(args, input, timeoutMs = 30000) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-WindowStyle',
          'Hidden',
          '-File',
          PS_HELPER,
          ...args,
        ],
        { windowsHide: true },
      );
    } catch (e) {
      resolve({ code: null, stdout: '', stderr: String(e) });
      return;
    }
    const out = [];
    const err = [];
    let timer = null;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* 忽略 */
        }
      }, timeoutMs);
    }
    const done = (r) => {
      if (timer) clearTimeout(timer);
      resolve(r);
    };
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', (e) => done({ code: null, stdout: '', stderr: String(e?.message || e) }));
    child.on('close', (code) =>
      done({
        code,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      }),
    );
    if (input !== undefined) {
      child.stdin.write(Buffer.from(input, 'utf8'));
      child.stdin.end();
    }
  });
}

/** 从 PowerShell 输出里抠出那行 JSON（容忍前面有别的输出） */
function parseJsonLine(text) {
  const lines = String(text || '')
    .trim()
    .split(/\r?\n/)
    .reverse();
  for (const line of lines) {
    const s = line.trim();
    if (!s.startsWith('{')) continue;
    try {
      return JSON.parse(s);
    } catch {
      /* 换下一行再试 */
    }
  }
  return null;
}

async function loadStoredCredentials() {
  if (!existsSync(CRED_STORE)) return null;
  const r = await psCall(['-Load', '-Path', CRED_STORE]);
  if (r.code !== 0) {
    warn(`读加密保存的账号失败：${(r.stderr || '').trim() || '退出码 ' + r.code}`);
    return null;
  }
  const j = parseJsonLine(r.stdout);
  if (!j || !j.username || !j.password) {
    warn('加密保存的文件里内容不完整');
    return null;
  }
  return j;
}

async function saveStoredCredentials(username, password) {
  const r = await psCall(['-Save', '-Path', CRED_STORE], JSON.stringify({ username, password }));
  if (r.code !== 0) warn(`加密保存失败：${(r.stderr || '').trim() || '退出码 ' + r.code}`);
  return r.code === 0;
}

/**
 * 在终端里问一行（密码可以打码）。
 * 提示文字写到标准错误：这样即使标准输出被重定向进日志，
 * 你在窗口里照样能看到提示。
 */
function askInTerminal(promptText, { mask = false } = {}) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      reject(
        new Error(
          '现在不是在一个终端窗口里运行，没法交互输入账号密码。\n' +
            '  请在「Windows 终端」或「命令提示符」里运行，或者用 --creds 指定账号文件。',
        ),
      );
      return;
    }
    process.stderr.write(promptText);
    let buf = '';
    const cleanup = () => {
      stdin.removeListener('data', onData);
      try {
        stdin.setRawMode(false);
      } catch {
        /* 忽略 */
      }
      stdin.pause();
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          cleanup();
          process.stderr.write('\n');
          resolve(buf);
          return;
        }
        if (ch === '\u0003') {
          // Ctrl+C
          cleanup();
          process.stderr.write('\n');
          const err = new Error('你取消了输入，本次退出。');
          err.cancelled = true;
          reject(err);
          return;
        }
        if (ch === '\u007f' || ch === '\b') {
          if (buf.length) {
            buf = buf.slice(0, -1);
            process.stderr.write('\b \b');
          }
          continue;
        }
        if (ch < ' ') continue; // 其它控制字符忽略
        buf += ch;
        process.stderr.write(mask ? '*' : ch);
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    stdin.on('data', onData);
  });
}

/** 第一次运行时：在终端窗口里问账号密码 */
async function askInTerminalForCredentials() {
  process.stderr.write('\n');
  process.stderr.write('第一次使用：请输入网络学堂的账号密码\n');
  process.stderr.write('（只输这一次，之后会加密保存在本机，下次直接使用）\n\n');
  const username = (await askInTerminal('账号（学号 / 工作证号）: ')).trim();
  if (!username) throw new Error('没有输入账号，本次退出。');
  const password = await askInTerminal('密码（输入时显示为 *）: ', { mask: true });
  if (!password) throw new Error('没有输入密码，本次退出。');
  return { username, password };
}

/**
 * 拿到账号密码，顺序是：
 *   1) 加密文件里有        → 直接用，不再打扰你
 *   2) 只有老的明文 txt    → 加密保存下来，确认能解回来后删掉明文
 *   3) 都没有              → 弹窗让你输一次，然后加密保存
 */
async function obtainCredentials(explicitFile) {
  if (explicitFile) {
    const c = await readCredentials(explicitFile);
    return { username: c.username, password: c.password, source: `指定的文件：${explicitFile}` };
  }

  const stored = await loadStoredCredentials();
  if (stored) {
    return {
      username: stored.username,
      password: stored.password,
      source: '加密保存的账号（credentials.dat）',
    };
  }

  const legacy = [
    path.join(HERE, 'credentials.txt'),
    path.join(process.cwd(), 'credentials.txt'),
  ].find((p) => existsSync(p));
  if (legacy) {
    const c = await readCredentials(legacy);
    if (c.encoding === 'gbk') log('  （检测到明文文件是 GBK 编码，已按 GBK 读取）');
    if (await saveStoredCredentials(c.username, c.password)) {
      const back = await loadStoredCredentials();
      if (back && back.username === c.username && back.password === c.password) {
        log(`· 已把 ${path.basename(legacy)} 里的账号加密保存，并删除那个明文文件`);
        try {
          await unlink(legacy);
        } catch {
          warn('明文文件没能自动删掉，你可以手动删除它');
        }
      } else {
        warn('加密保存后没能解回来，明文文件先保留');
      }
    }
    return { username: c.username, password: c.password, source: `明文文件：${legacy}` };
  }

  log('· 第一次使用：请在终端窗口里输入账号密码（只输这一次，之后会加密存在本机）');
  const entered = await askInTerminalForCredentials();
  if (await saveStoredCredentials(entered.username, entered.password)) {
    log('· 账号密码已加密保存到 credentials.dat，以后运行不再询问');
  } else {
    warn('账号密码这次没能保存下来，下次运行还会再问一次');
  }
  return { username: entered.username, password: entered.password, source: '刚输入并加密保存' };
}

// --------------------------------------------------------------------------
// 找浏览器
// --------------------------------------------------------------------------
function findBrowser() {
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env.LOCALAPPDATA || '';
  const candidates = [
    process.env.EDGE_PATH,
    path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    local && path.join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    local && path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ].filter(Boolean);
  for (const p of candidates) if (existsSync(p)) return p;
  throw new Error('没找到 Edge 或 Chrome 浏览器。可以用环境变量 EDGE_PATH 指定浏览器路径。');
}

async function devtoolsReady(port, waitMs) {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    let info = null;
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(1500),
      });
      if (r.ok) info = await r.json();
    } catch {
      /* 还没起来，继续等 */
    }
    if (info) {
      const brand = String((info && info.Browser) || '');
      // 端口被不是浏览器的程序占用时，早点说清楚，别让人干等
      if (brand && !/^(Edg|Chrome|HeadlessChrome)\b/.test(brand)) {
        throw new Error(
          `端口 ${port} 被别的程序占用了（它自报为 "${brand}"）。\n` +
            `  请换一个端口，例如 --port 9400。`,
        );
      }
      if (info.webSocketDebuggerUrl) return info;
    }
    await sleep(300);
  }
  return null;
}

/**
 * 把你自己 Edge 里的一些东西搬进独立窗口的配置，让它"像你的浏览器"：
 *   · 书签、图标
 *   · 登录状态（cookies）——新版 Edge 给 cookie 加了绑定加密，
 *     能不能搬过去要看运气，能不能用程序会实测并告诉你
 *   · Local State（cookie 的解密密钥在这里，不搬它 cookie 一律解不开）
 * 刻意不搬：保存的密码、浏览历史、扩展、缓存。
 */
async function copyFromExistingEdge(profileDir) {
  const userData = edgeUserDataDir();
  if (!userData || !existsSync(userData)) {
    return { ok: false, reason: `找不到你平时 Edge 的配置目录：${userData || '位置未知'}` };
  }
  const srcDefault = path.join(userData, 'Default');
  const dstDefault = path.join(profileDir, 'Default');
  await mkdir(path.join(dstDefault, 'Network'), { recursive: true });

  const jobs = [
    [path.join(userData, 'Local State'), path.join(profileDir, 'Local State')],
    [path.join(srcDefault, 'Bookmarks'), path.join(dstDefault, 'Bookmarks')],
    [path.join(srcDefault, 'Favicons'), path.join(dstDefault, 'Favicons')],
    [path.join(srcDefault, 'Network', 'Cookies'), path.join(dstDefault, 'Network', 'Cookies')],
    [
      path.join(srcDefault, 'Network', 'Cookies-wal'),
      path.join(dstDefault, 'Network', 'Cookies-wal'),
    ],
    [
      path.join(srcDefault, 'Network', 'Cookies-shm'),
      path.join(dstDefault, 'Network', 'Cookies-shm'),
    ],
    [path.join(srcDefault, 'Local Storage'), path.join(dstDefault, 'Local Storage')],
  ];

  const copied = [];
  const failed = [];
  for (const [from, to] of jobs) {
    if (!existsSync(from)) continue;
    try {
      await cp(from, to, { recursive: true, force: true });
      copied.push(path.basename(from));
    } catch {
      failed.push(path.basename(from));
    }
  }
  return { ok: true, copied, failed };
}

/**
 * 启动一个独立的 Edge 窗口（自己的配置目录，与你平时的 Edge 互不影响），
 * 并带上本机调试端口，这样程序才能接管这个窗口里的标签页。
 * 上一次启动的窗口如果还开着（端口还在），就直接接管它。
 */
async function launchBrowser(exe, port, profileDir, url) {
  if (await devtoolsReady(port, 1200)) {
    log(`· 接管上次打开的独立 Edge 窗口（端口 ${port}）`);
    return;
  }

  await mkdir(profileDir, { recursive: true });
  const args = [
    `--remote-debugging-port=${port}`,
    // 刻意不加 --remote-allow-origins=*：不加时 Node 的 WebSocket 照样连得上
    // （它不带 Origin 头），但网页发起的连接会被 Edge 拒绝，
    // 免得本机某个网页跑到 127.0.0.1 上把这个窗口接管走。
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-session-crashed-bubble',
    url,
  ];
  const child = spawn(exe, args, { detached: true, stdio: 'ignore' });
  child.unref();

  const info = await devtoolsReady(port, 40000);
  if (!info) {
    throw new Error(
      '浏览器启动超时，没能拿到调试端口。\n' +
        `  常见原因：已经有一个 Edge 在用同一个配置目录（${profileDir}）运行，但没带调试端口。\n` +
        '  解决：把那个独立窗口关掉再运行，或用 --profile 换一个配置目录。',
    );
  }
}

/** 记录本程序自己开的那个标签页，下次直接复用它 */
function tabStateFile(profileDir) {
  return path.join(profileDir, 'autologin-tab.json');
}

async function readSavedTabId(profileDir) {
  try {
    const j = JSON.parse(await readFile(tabStateFile(profileDir), 'utf8'));
    return typeof j.tabId === 'string' ? j.tabId : '';
  } catch {
    return '';
  }
}

async function saveTabId(profileDir, tabId) {
  try {
    await mkdir(profileDir, { recursive: true });
    await writeFile(tabStateFile(profileDir), JSON.stringify({ tabId }), 'utf8');
  } catch {
    /* 记不住也不影响本次使用 */
  }
}

/**
 * 拿到本次要操作的标签页。
 * 只认「本程序自己开过的那个」，绝不按网址去挑标签页——
 * 否则可能把你在这个窗口里手动打开的页面接管并导航走。
 */
async function findPageTarget(port, url, profileDir) {
  const savedId = await readSavedTabId(profileDir);
  if (savedId) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const hit = list.find((t) => t.type === 'page' && t.id === savedId);
      if (hit && hit.webSocketDebuggerUrl) {
        log('· 复用上次打开的那个标签页');
        return hit;
      }
    } catch {
      /* 读不到标签页列表就新开一个 */
    }
  }
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, {
      method: 'PUT',
      signal: AbortSignal.timeout(8000),
    });
    if (r.ok) {
      const t = await r.json();
      await saveTabId(profileDir, t.id);
      log('· 在 Edge 里新建一个标签页');
      return t;
    }
  } catch {
    /* 老版本浏览器不支持 PUT，用下面的兜底 */
  }
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('无法新建浏览器标签页');
  await saveTabId(profileDir, page.id);
  return page;
}

// --------------------------------------------------------------------------
// 极简 CDP（浏览器调试协议）客户端
// --------------------------------------------------------------------------
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.id === undefined) return;
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || 'CDP 调用失败'));
      else p.resolve(msg.result);
    });
  }

  send(method, params = {}, timeoutMs = 30000) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`调用 ${method} 超时`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* 忽略 */
    }
  }
}

async function connect(wsUrl) {
  if (typeof WebSocket === 'undefined') {
    throw new Error('你的 Node 版本太旧，请使用 Node 22 或更新版本。');
  }
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('连接浏览器调试端口失败')), {
      once: true,
    });
  });
  return new CDP(ws);
}

// --------------------------------------------------------------------------
// 页面操作小工具
// --------------------------------------------------------------------------
async function evaluate(cdp, expression, { awaitPromise = false, userGesture = false } = {}) {
  const r = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise,
    returnByValue: true,
    userGesture,
  });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description || '页面脚本执行出错');
  }
  return r.result ? r.result.value : undefined;
}

async function navigate(cdp, url) {
  const r = await cdp.send('Page.navigate', { url });
  if (r && r.errorText) throw new Error(`打开页面失败：${r.errorText}（${url}）`);
  await sleep(400);
}

async function currentUrl(cdp) {
  for (let i = 0; i < 8; i++) {
    try {
      const v = await evaluate(cdp, 'location.href');
      if (typeof v === 'string' && v) return v;
    } catch {
      /* 正在跳转，重试 */
    }
    await sleep(250);
  }
  return '';
}

/**
 * 判断当前页面处于什么状态。
 * 注意：网络学堂对未登录的课程页是「原地」返回一个「登录超时」提示页（URL 不变），
 * 所以不能只看网址，必须看页面内容。
 */
async function detectState(cdp) {
  for (let i = 0; i < 10; i++) {
    try {
      const s = await evaluate(
        cdp,
        `(() => {
          const title = document.title || '';
          const body = document.body ? (document.body.innerText || '').slice(0, 400) : '';
          return {
            href: location.href,
            host: location.host,
            path: location.pathname,
            title: title,
            loginPage: location.pathname.startsWith('/f/login') || !!document.querySelector('#loginButtonId'),
            onIdpLogin: !!document.querySelector('#theform') || !!document.querySelector('#i_user'),
            expired: title.includes('登录超时') || body.includes('您未登录或登录失效'),
          };
        })()`,
      );
      if (s && s.href) return s;
    } catch {
      /* 正在跳转，重试 */
    }
    await sleep(250);
  }
  return null;
}

// 「这个页面说明还没登录」——注意 s 为 null 表示「读不出来」，
// 那是另一回事，由调用方单独处理。
const needsLogin = (s) => !!s && (s.loginPage || s.expired || s.onIdpLogin);

async function waitFor(cdp, expression, { timeoutMs = 45000, label = '页面元素' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await evaluate(cdp, expression)) return true;
    } catch {
      /* 跳转中，忽略 */
    }
    await sleep(250);
  }
  throw new Error(`等待超时：${label}`);
}

function jsSetValue(selector, value) {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    el.focus();
    setter.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`;
}

/** 诊断截图的落地点：放系统临时目录，别把程序目录弄脏 */
function shotPath(name) {
  return path.join(os.tmpdir(), `tsinghua-learn-autologin-${name}.png`);
}

async function screenshot(cdp, file) {
  try {
    // 先把标签页提到前台：后台/被遮挡的标签页有时截不出图（会一直等到超时）
    try {
      await cdp.send('Page.bringToFront', {}, 5000);
      await sleep(300);
    } catch {
      /* 提不到前台也照样试着截 */
    }
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' }, 20000);
    if (r && r.data) {
      await writeFile(file, Buffer.from(r.data, 'base64'));
      return file;
    }
  } catch {
    /* 截图只是辅助，失败不影响主流程 */
  }
  return null;
}

// --------------------------------------------------------------------------
// 主流程
// --------------------------------------------------------------------------
async function main() {
  if (typeof fetch !== 'function' || typeof WebSocket === 'undefined') {
    throw new Error(
      `这个程序需要 Node.js 22 或更新版本，当前是 ${process.version}。\n` +
        '  请到 https://nodejs.org/zh-cn/download 下载新版安装，然后重新运行。',
    );
  }

  const opt = parseArgs(process.argv.slice(2));
  if (opt.help) {
    printHelp();
    return;
  }

  const creds = await obtainCredentials(opt.creds);
  log('');
  log('清华大学网络学堂 自动登录');
  log(`  账号密码来源：${creds.source}`);
  log(`  登录账号：${maskAccount(creds.username)}（日志里做了打码）`);
  log('');

  const exe = findBrowser();
  log(`· 浏览器：${path.basename(exe)}`);
  log(`  独立窗口配置目录：${opt.profile}（你平时的 Edge 不受影响）`);

  // 别把独立窗口的配置指到你平时 Edge 的配置目录上：
  // 那样会抢占它（Edge 一个配置只能有一个实例），还可能"自己拷自己"
  const realUserData = edgeUserDataDir();
  if (realUserData) {
    const mine = path.resolve(opt.profile).toLowerCase();
    const real = path.resolve(realUserData).toLowerCase();
    if (mine === real || mine.startsWith(real + path.sep)) {
      throw new Error(
        '--profile 指到了你平时 Edge 的配置目录，这样会抢占它。\n' +
          `  现在指的是：${opt.profile}\n` +
          '  请换一个空目录，或者干脆不加 --profile（用默认的独立配置目录）。',
      );
    }
  }
  if (path.resolve(opt.profile).toLowerCase().startsWith(path.resolve(HERE).toLowerCase() + path.sep)) {
    warn(`独立窗口的配置放在程序目录里（${opt.profile}），浏览器缓存会让这个目录越来越大。`);
  }

  if (opt.copyProfile) {
    if (existsSync(path.join(opt.profile, 'Default'))) {
      log('  （独立窗口的配置已经存在，跳过复制；想重来就先删掉那个目录）');
    } else {
      const r = await copyFromExistingEdge(opt.profile);
      if (r.ok) {
        log(
          `· 已从你平时的 Edge 复制：${r.copied.length ? r.copied.join('、') : '（没找到可复制的内容）'}`,
        );
        if (r.failed.length) {
          warn(
            `这些没能复制：${r.failed.join('、')}\n` +
              '    多半是因为你平时的 Edge 正开着，把文件锁住了；' +
              '想要连登录状态一起复制，需要先把 Edge 完全关掉再运行。',
          );
        }
      } else {
        warn(r.reason);
      }
    }
  }

  // 一定要用站点根地址，不能用课程页地址：
  // 未登录时访问课程页，服务器是「原地」返回一个"您未登录或登录失效"的提示页（网址不变），
  // 只有根地址才会正规地跳到登录页（已登录时则直接跳到课程页）。
  const origin = new URL(opt.site).origin;
  const startUrl = origin + '/';

  await launchBrowser(exe, opt.port, opt.profile, startUrl);

  const target = await findPageTarget(opt.port, startUrl, opt.profile);
  if (!target.webSocketDebuggerUrl) throw new Error('拿不到标签页调试地址');
  const cdp = await connect(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  try {
    // 打开的就已经是站点根地址了，这里只等它跳转/加载完，再判断登录状态
    await waitFor(cdp, `document.readyState === 'complete'`, {
      timeoutMs: 45000,
      label: '页面加载完成',
    });
    await sleep(500);

    let state = await detectState(cdp);
    if (state) log(`· 当前页面：${state.href}`);
    else warn('读不出当前页面的状态，按「未登录」处理');
    if (state && !needsLogin(state)) {
      log('· 检测到浏览器里已有有效登录状态，跳过登录步骤。');
    } else {
      // 从登录页按钮上读出统一身份认证入口，读不到就用固定地址兜底
      let ssoUrl = '';
      if (!state || !state.loginPage) {
        // 没落在登录页，就直接去登录页拿入口
        await navigate(cdp, origin + '/f/login');
        await waitFor(cdp, `document.readyState === 'complete'`, {
          timeoutMs: 45000,
          label: '登录页加载完成',
        });
        state = await detectState(cdp);
      }
      try {
        ssoUrl = await evaluate(
          cdp,
          `(() => {
            const el = document.querySelector('#loginButtonId');
            if (!el) return '';
            const m = (el.getAttribute('onclick') || '').match(/https?:\\/\\/[^'"\\s]+/);
            return m ? m[0] : '';
          })()`,
        );
      } catch {
        /* 忽略 */
      }
      if (!ssoUrl) ssoUrl = opt.ssoFallback;

      log('· 跳转到清华统一身份认证');
      await navigate(cdp, ssoUrl);
      await waitFor(cdp, `document.readyState === 'complete'`, {
        timeoutMs: 45000,
        label: '认证页加载完成',
      });
      await sleep(600);

      const afterSso = await detectState(cdp);
      if (afterSso && afterSso.host === new URL(opt.site).host) {
        log('· 认证系统记住了这台浏览器，直接跳回网络学堂，无需输入密码。');
      } else {
        await waitFor(cdp, `!!document.querySelector('#i_user')`, {
          timeoutMs: 30000,
          label: '认证页的用户名输入框',
        });

        const okUser = await evaluate(cdp, jsSetValue('#i_user', creds.username));
        const okPass = await evaluate(cdp, jsSetValue('#i_pass', creds.password));
        if (!okUser || !okPass) throw new Error('没能在认证页找到用户名/密码输入框');
        log('· 已填入账号密码');

        if (opt.trustBrowser) {
          await evaluate(
            cdp,
            `(() => {
              const box = document.querySelector('input[name="singleLogin"]');
              if (!box) return false;
              if (!box.checked) { box.click(); }
              return true;
            })()`,
          );
          log('· 已勾选「信任浏览器（统一登录）」');
        }

        if (opt.dryRun) {
          const shot = await screenshot(cdp, shotPath('dry-run'));
          log('');
          log('（--dry-run 模式：只填表，没有提交登录）');
          if (shot) log(`  截图：${shot}`);
          log('  浏览器会保持打开，你可以自己点「登录」验证。');
          return;
        }

        // 需要图形验证码时，交给人在浏览器里补一下
        const needCaptcha = await evaluate(
          cdp,
          `(() => {
            const box = document.querySelector('#c_code');
            return !!box && !box.classList.contains('hidden');
          })()`,
        );
        if (needCaptcha) {
          log('');
          log('  本次登录需要图形验证码。请在刚打开的浏览器窗口里');
          log('  输入 4 位验证码，程序会自动继续。');
          await waitFor(
            cdp,
            `(() => { const i = document.querySelector('#i_code'); return !!i && i.value.length === 4; })()`,
            { timeoutMs: opt.timeoutSec * 1000, label: '你输入验证码' },
          );
          log('· 收到验证码，继续提交');
        }

        log('· 提交登录（密码由网页自身用国密 SM2 加密后发送）');
        let callError = null;
        try {
          await evaluate(cdp, 'doLogin()', { userGesture: true });
        } catch (e) {
          callError = e;
        }
        await sleep(1200);
        // 判断是否真的已经提交：密文写进了隐藏域，或者页面已经跳走
        let submitted = false;
        try {
          const probe = await evaluate(
            cdp,
            `(() => {
              const hidden = document.querySelector('#sm2pass');
              return {
                cipherLen: hidden ? (hidden.value || '').length : 0,
                stillHere: !!document.querySelector('#theform'),
              };
            })()`,
          );
          submitted = probe.cipherLen > 60 || !probe.stillHere;
        } catch {
          // 执行上下文被销毁说明页面正在跳转，也就是已经提交了
          submitted = true;
        }
        if (!submitted) {
          if (callError) warn('网页自带的提交函数不可用，改用等价方式提交');
          await evaluate(
            cdp,
            `(() => {
              const pub = (document.querySelector('#sm2publicKey') || {}).textContent || '';
              const plain = document.querySelector('#i_pass');
              const hidden = document.querySelector('#sm2pass');
              const form = document.querySelector('#theform');
              if (!plain || !hidden || !form) return false;
              hidden.value = sm2Util.doEncryptStr(plain.value, pub.trim());
              form.submit();
              return true;
            })()`,
            { userGesture: true },
          );
          log('  （使用了备用提交方式）');
        }

        const result = await waitForLoginResult(cdp, opt.timeoutSec * 1000, new URL(opt.site).host);
        if (!result.ok) {
          const shot = await screenshot(cdp, shotPath('login-failed'));
          if (result.error) {
            // 认证页明确报错（多半是账号密码不对）：把存下来的账号删掉，
            // 免得下次又拿着错的账号静默失败，让你没有机会重输
            if (creds.source.includes('credentials.dat')) {
              try {
                await unlink(CRED_STORE);
                log('· 登录被拒，已删除本机保存的账号，下次运行会重新问你一次');
              } catch {
                /* 删不掉就算了，不影响这次报错 */
              }
            }
            throw new Error(
              `登录失败：${result.error}\n` +
                '  （账号或密码不对、账号被锁、或需要校园网/VPN 环境）' +
                (shot ? `\n  现场截图：${shot}` : ''),
            );
          }
          throw new Error(
            '在限定时间内没有等到登录完成。\n' +
              `  当前页面：${result.where || '未知'}\n` +
              '  可能需要二次验证：请在浏览器窗口里手动完成，' +
              '如果成功就表示账号密码是对的，只是流程比预期多一步。' +
              (shot ? `\n  现场截图：${shot}` : ''),
          );
        }
        if (result.leftIdp) {
          log(`· 认证页已跳走（当前 ${result.where}），正在确认网络学堂的会话`);
        } else {
          log('· 认证系统已跳回网络学堂');
        }
      }
    }

    // 回到目标页面
    const wantPath = new URL(opt.site).pathname;
    let here = await currentUrl(cdp);
    if (!here.includes(wantPath)) {
      log(`· 进入目标页面：${wantPath}`);
      await navigate(cdp, opt.site);
      await waitFor(cdp, `document.readyState === 'complete'`, {
        timeoutMs: 45000,
        label: '目标页加载完成',
      });
    }

    await sleep(800);
    const finalState = await detectState(cdp);
    const finalUrl = finalState ? finalState.href : await currentUrl(cdp);
    const finalTitle = finalState ? finalState.title : '';
    log('');
    if (!finalState) {
      throw new Error(
        '读不出最终页面的状态，没法确认是否登录成功。\n' +
          `  当前地址：${finalUrl || '未知'}\n` +
          '  页面可能还在跳转，或者浏览器已经被关掉。请到浏览器窗口看一眼，或重跑一次。',
      );
    }
    if (needsLogin(finalState)) {
      throw new Error(
        '最后仍然显示未登录状态，登录没有真正生效。\n' +
          `  结束时的页面：${finalUrl}（标题：${finalTitle || '无'}）\n` +
          '  如果认证过程中出现过二次验证或验证码，请在浏览器窗口里手动完成；\n' +
          '  如果并没有出现，多半是账号密码不对，或需要连校园网/VPN。',
      );
    }
    log('完成，已停留在：');
    log(`  ${finalUrl}`);
    log(`  页面标题：${finalTitle}`);
    log('  浏览器保持打开，可以直接使用；关闭浏览器即可退出。');
    log('');
  } finally {
    cdp.close();
  }
}

/**
 * 等认证结果：
 *   - 回到网络学堂           → 成功
 *   - 认证页不再有登录表单   → 认为已离开认证页（可能还有一步跳转），继续往下走由目标页判断
 *   - 出现错误提示           → 失败
 */
async function waitForLoginResult(cdp, timeoutMs, siteHost) {
  const deadline = Date.now() + timeoutMs;
  let lastWhere = '';
  while (Date.now() < deadline) {
    let state = null;
    try {
      state = await evaluate(
        cdp,
        `(() => {
          const note = document.querySelector('#c_note');
          const noteVisible = !!note && getComputedStyle(note).display !== 'none';
          const msg = document.querySelector('#msg_note');
          return {
            host: location.host,
            path: location.pathname,
            hasForm: !!document.querySelector('#theform'),
            err: noteVisible && msg ? (msg.textContent || '').trim() : '',
          };
        })()`,
      );
    } catch {
      /* 跳转中 */
    }
    if (state && state.host) {
      lastWhere = state.host + state.path;
      if (state.err) return { ok: false, error: state.err, where: lastWhere };
      if (state.host === siteHost) return { ok: true, where: lastWhere };
      if (state.host !== siteHost && !state.hasForm) {
        // 认证页已经跳走，给跳转链条一点时间
        await sleep(2000);
        const later = await detectState(cdp);
        if (later && later.host === siteHost) return { ok: true, where: later.href };
        return { ok: true, where: lastWhere, leftIdp: true };
      }
    }
    await sleep(400);
  }
  return { ok: false, error: '', where: lastWhere };
}

main().catch((e) => {
  const cancelled = !!(e && e.cancelled);
  console.error('');
  console.error((cancelled ? '' : '出错了：') + (e && e.message ? e.message : e));
  console.error('');
  process.exitCode = cancelled ? 3 : 1; // 3 = 用户主动取消，别当成故障
});

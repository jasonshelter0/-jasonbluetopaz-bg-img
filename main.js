'use strict';

/*
 * Jason Blue Topaz BG — one-command wallpaper updater for the Blue Topaz fork.
 *
 * Pipeline: pick mode + image → base64 → GitHub Contents API (GET sha → PUT) →
 * purge jsDelivr → bump ?v=N → write CSS snippet → enable + reload.
 *
 * Two one-time external requirements:
 *   1. A GitHub PAT with `repo` scope (set in plugin settings).
 *   2. The theme's "Activate Image Background" toggle left ON.
 *
 * The PAT is stored in the OS keychain (Obsidian secret storage) when available,
 * falling back to base64-obfuscated data.json on older Obsidian. Never logged.
 */

const { Plugin, PluginSettingTab, Setting, FuzzySuggestModal, Notice, requestUrl, SecretComponent } = require('obsidian');

// ── Constants ────────────────────────────────────────────────────────────────
const SNIPPET_ID = 'qa-wallpaper';
const SNIPPET_PATH = '.obsidian/snippets/qa-wallpaper.css';
const SNIPPETS_DIR = '.obsidian/snippets';
const IMAGE_RE = /\.(jpe?g|png|gif|webp|bmp|avif)$/i;
const TOKEN_PREFIX = 'b64:';
const PAT_SECRET_ID = 'jbt-bg-github-pat'; // Obsidian secretStorage key (OS keychain)

const DEFAULT_SETTINGS = {
  poolFolder: 'Wallpapers',
  githubOwner: 'jasonshelter0',
  githubRepo: '-jasonbluetopaz-bg-img',
  githubBranch: 'main',
  githubToken: '',
  remoteFolder: 'wallpapers',
  lightFile: 'wallpaper-light.jpg',
  darkFile: 'wallpaper-dark.jpg',
  versionCounter: 1,
};

// ── Helpers ──────────────────────────────────────────────────────────────────
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

// Light obfuscation for the PAT (not crypto — just keeps it out of plain sight).
function b64encode(str) { return btoa(unescape(encodeURIComponent(str))); }
function b64decode(str) { return decodeURIComponent(escape(atob(str))); }
function obfuscate(t) { return t.startsWith(TOKEN_PREFIX) ? t : TOKEN_PREFIX + b64encode(t); }
function deobfuscate(t) { return t.startsWith(TOKEN_PREFIX) ? b64decode(t.slice(TOKEN_PREFIX.length)) : t; }

// Copy text to the clipboard, with a fallback for older/odd environments.
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    const el = document.createElement('textarea');
    el.value = text;
    el.style.position = 'fixed';
    el.style.opacity = '0';
    document.body.appendChild(el);
    el.select();
    try { document.execCommand('copy'); } catch (e2) { /* ignore */ }
    document.body.removeChild(el);
  }
}

// ── Modals ───────────────────────────────────────────────────────────────────
class ModePickerModal extends FuzzySuggestModal {
  constructor(app, onSubmit) {
    super(app);
    this.onSubmit = onSubmit;
    this.setPlaceholder('Pick mode (Light / Dark)');
  }
  getItems() { return ['Light', 'Dark']; }
  getItemText(item) { return item; }
  onChooseItem(item) { this.onSubmit(item.toLowerCase()); }
}

class ImagePickerModal extends FuzzySuggestModal {
  constructor(app, files, onSubmit) {
    super(app);
    this.files = files;
    this.onSubmit = onSubmit;
    this.setPlaceholder('Pick an image');
  }
  getItems() { return this.files; }
  getItemText(path) { return path.split('/').pop(); }
  onChooseItem(path) { this.onSubmit(path); }
}

// ── Settings tab ─────────────────────────────────────────────────────────────
class JBTBGSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    const p = this.plugin;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'Jason Blue Topaz BG' });

    new Setting(containerEl)
      .setName('Pool folder')
      .setDesc('Vault-relative folder where you drop wallpaper images. Created automatically.')
      .addText((t) => {
        t.setPlaceholder('Wallpapers')
          .setValue(p.settings.poolFolder)
          .onChange(async (v) => {
            p.settings.poolFolder = v.trim() || 'Wallpapers';
            await p.saveSettings();
          });
        // Create the folder on commit (blur/Enter) — not every keystroke —
        // so typing "Assets/Wallpapers" doesn't leave stray half-typed folders.
        t.inputEl.addEventListener('change', async () => { await p.ensurePool(); });
      });

    if (this.app.secretStorage) {
      new Setting(containerEl)
        .setName('GitHub PAT')
        .setDesc('Stored in the OS keychain (Obsidian secret storage). Never logged.')
        .addComponent((el) => new SecretComponent(this.app, el)
          .setValue(p.settings.githubToken || '')
          .onChange((val) => p.setToken(val || '')))
        .addButton((b) => b
          .setButtonText('Clear')
          .onClick(async () => { await p.setToken(''); this.display(); }));
    } else {
      new Setting(containerEl)
        .setName('GitHub PAT')
        .setDesc('Stored obfuscated in data.json. Update Obsidian (1.11.4+) for OS keychain storage.')
        .addText((t) => t
          .setPlaceholder(p.settings.githubToken ? '•••••••• (set — type to replace)' : 'ghp_…')
          .onChange(async (v) => { const val = v.trim(); if (val) { await p.setToken(val); } }))
        .addButton((b) => b
          .setButtonText('Clear')
          .onClick(async () => { await p.setToken(''); this.display(); }));
    }

    new Setting(containerEl)
      .setName('Test GitHub auth')
      .setDesc('Verify the PAT works.')
      .addButton((b) => b.setButtonText('Test').onClick(() => this.testToken()));

    containerEl.createEl('h3', { text: 'GitHub repo' });
    new Setting(containerEl).setName('Owner').addText((t) => t.setValue(p.settings.githubOwner).onChange(async (v) => { p.settings.githubOwner = v.trim(); await p.saveSettings(); }));
    new Setting(containerEl).setName('Repo').addText((t) => t.setValue(p.settings.githubRepo).onChange(async (v) => { p.settings.githubRepo = v.trim(); await p.saveSettings(); }));
    new Setting(containerEl).setName('Branch').addText((t) => t.setPlaceholder('main').setValue(p.settings.githubBranch).onChange(async (v) => { p.settings.githubBranch = v.trim() || 'main'; await p.saveSettings(); }));
    new Setting(containerEl).setName('Remote folder').setDesc('Folder inside the repo.').addText((t) => t.setPlaceholder('wallpapers').setValue(p.settings.remoteFolder).onChange(async (v) => { p.settings.remoteFolder = v.trim() || 'wallpapers'; await p.saveSettings(); }));

    containerEl.createEl('h3', { text: 'Fixed filenames' });
    new Setting(containerEl).setName('Light file').addText((t) => t.setValue(p.settings.lightFile).onChange(async (v) => { p.settings.lightFile = v.trim(); await p.saveSettings(); }));
    new Setting(containerEl).setName('Dark file').addText((t) => t.setValue(p.settings.darkFile).onChange(async (v) => { p.settings.darkFile = v.trim(); await p.saveSettings(); }));

    containerEl.createEl('h3', { text: 'Cache' });
    new Setting(containerEl)
      .setName('Version counter')
      .setDesc("Auto-increments each update; bumps ?v=N to beat Obsidian's 7-day browser cache.")
      .addText((t) => t
        .setValue(String(p.settings.versionCounter))
        .onChange(async (v) => { const n = parseInt(v, 10); if (!isNaN(n)) { p.settings.versionCounter = n; await p.saveSettings(); } }));
  }

  async testToken() {
    const p = this.plugin;
    if (!p.settings.githubToken) { new Notice('Enter a PAT first.'); return; }
    try {
      const res = await requestUrl({
        url: 'https://api.github.com/rate_limit',
        method: 'GET',
        headers: { Authorization: `token ${p.settings.githubToken}`, Accept: 'application/vnd.github+json' },
        throw: false,
      });
      if (res.status === 200) {
        console.log('[JBT-BG] token OK — core rate limit remaining:', res.json.resources.core.remaining);
        new Notice('Token OK ✓');
      } else {
        console.error('[JBT-BG] token check failed:', res.status, res.text);
        new Notice(`Token check failed (${res.status})`);
      }
    } catch (e) {
      console.error('[JBT-BG] token check error:', e);
      new Notice('Token check error — see console');
    }
  }
}

// ── Plugin ───────────────────────────────────────────────────────────────────
class JBTBGPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.addSettingTab(new JBTBGSettingTab(this.app, this));
    this.addCommand({
      id: 'update-wallpaper',
      name: 'Update wallpaper',
      callback: () => this.runPickerFlow(),
    });
    await this.setupLocal();
  }

  async loadSettings() {
    const data = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data || {});
    this.settings.githubToken = this.resolveToken(this.settings.githubToken);
  }

  // Prefer the OS keychain (Obsidian secretStorage); migrate + fall back to data.json.
  resolveToken(rawLegacy) {
    let tok = '';
    try {
      if (this.app.secretStorage) {
        tok = this.app.secretStorage.getSecret(PAT_SECRET_ID) || '';
        if (!tok && rawLegacy) {
          tok = deobfuscate(rawLegacy);
          if (tok) this.app.secretStorage.setSecret(PAT_SECRET_ID, tok);
        }
      } else if (rawLegacy) {
        tok = deobfuscate(rawLegacy);
      }
    } catch (e) {
      console.warn('[JBT-BG] keychain unavailable, using data.json:', e);
      tok = rawLegacy ? deobfuscate(rawLegacy) : '';
    }
    return tok;
  }

  async saveSettings() {
    const copy = Object.assign({}, this.settings);
    if (this.app.secretStorage) {
      delete copy.githubToken; // token lives in the keychain
    } else if (copy.githubToken) {
      copy.githubToken = obfuscate(copy.githubToken);
    }
    await this.saveData(copy);
  }

  // Update the PAT (live value + persistence). Never logged.
  async setToken(token) {
    token = (token || '').trim();
    this.settings.githubToken = token;
    if (this.app.secretStorage) {
      try { this.app.secretStorage.setSecret(PAT_SECRET_ID, token); } catch (e) { console.warn('[JBT-BG] keychain write failed:', e); }
    }
    await this.saveSettings();
  }

  // No network on start — just local setup.
  async setupLocal() {
    // 1. Ensure the pool folder exists.
    await this.ensurePool();

    // 2. Ensure the snippet file exists (stub; don't force-enable here).
    if (!(await this.app.vault.adapter.exists(SNIPPET_PATH))) {
      await this.writeSnippet();
      console.log('[JBT-BG] snippet stub created:', SNIPPET_PATH);
    }
  }

  // Create the pool folder (and any missing parent folders) if needed.
  async ensurePool() {
    const folder = this.settings.poolFolder;
    const parts = folder.split('/').filter(Boolean);
    let acc = '';
    for (const part of parts) {
      acc = acc ? `${acc}/${part}` : part;
      if (!(await this.app.vault.adapter.exists(acc))) {
        await this.app.vault.createFolder(acc);
      }
    }
    console.log('[JBT-BG] pool ready:', folder);
  }

  buildCss() {
    const s = this.settings;
    const base = `https://cdn.jsdelivr.net/gh/${s.githubOwner}/${s.githubRepo}@${s.githubBranch}/${s.remoteFolder}`;
    const light = `${base}/${s.lightFile}?v=${s.versionCounter}`;
    const dark = `${base}/${s.darkFile}?v=${s.versionCounter}`;
    return [
      '/* Jason Blue Topaz BG — auto-generated, do not edit */',
      'body.theme-light {',
      `  --theme-background: url("${light}") !important;`,
      '}',
      'body.theme-dark {',
      `  --theme-background: url("${dark}") !important;`,
      '}',
      '',
    ].join('\n');
  }

  async writeSnippet() {
    if (!(await this.app.vault.adapter.exists(SNIPPETS_DIR))) {
      await this.app.vault.createFolder(SNIPPETS_DIR);
    }
    await this.app.vault.adapter.write(SNIPPET_PATH, this.buildCss());
  }

  async runPickerFlow() {
    if (!this.settings.githubToken) {
      console.error('[JBT-BG] missing GitHub token');
      new Notice('Set your GitHub PAT in plugin settings first.');
      return;
    }
    new ModePickerModal(this.app, (mode) => this.pickImage(mode)).open();
  }

  async pickImage(mode) {
    let list;
    try {
      list = await this.app.vault.adapter.list(this.settings.poolFolder);
    } catch (e) {
      console.error('[JBT-BG] cannot list pool folder:', e);
      new Notice(`Cannot list folder "${this.settings.poolFolder}"`);
      return;
    }
    const images = list.files.filter((f) => IMAGE_RE.test(f));
    if (!images.length) {
      console.error('[JBT-BG] no images in pool:', this.settings.poolFolder);
      new Notice(`Drop images into "${this.settings.poolFolder}" first.`);
      return;
    }
    new ImagePickerModal(this.app, images, (img) => this.updateWallpaper(mode, img)).open();
  }

  // GitHub API call with one retry on network/server errors (China network is flaky).
  async githubFetch(method, url, payload) {
    const req = {
      url,
      method,
      headers: {
        Authorization: `token ${this.settings.githubToken}`,
        Accept: 'application/vnd.github+json',
      },
      throw: false,
    };
    if (payload) {
      req.body = JSON.stringify(payload);
      req.headers['Content-Type'] = 'application/json';
    }
    let res;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        res = await requestUrl(req);
      } catch (e) {
        if (attempt === 2) throw e;
        console.warn(`[JBT-BG] ${method} attempt ${attempt} network error, retrying…`);
        continue;
      }
      if (res.status >= 500) {
        if (attempt === 2) return res;
        console.warn(`[JBT-BG] ${method} attempt ${attempt} server ${res.status}, retrying…`);
        continue;
      }
      return res;
    }
    return res;
  }

  async updateWallpaper(mode, imagePath) {
    const s = this.settings;
    const fixedFile = mode === 'light' ? s.lightFile : s.darkFile;
    const remotePath = `${s.remoteFolder}/${fixedFile}`;
    const apiBase = `https://api.github.com/repos/${s.githubOwner}/${s.githubRepo}/contents`;
    let step = 'start';

    console.log('[JBT-BG] ── update start ──');
    console.log('[JBT-BG] mode:', mode, '| image:', imagePath, '| remote:', remotePath);

    try {
      // 1. Read binary + base64 (no data: prefix).
      step = '1 read image';
      const buf = await this.app.vault.adapter.readBinary(imagePath);
      const content = arrayBufferToBase64(buf);
      console.log(`[JBT-BG] 1. read ${buf.byteLength} bytes → base64 ${content.length} chars`);

      // 2. Check current file → get sha (git status).
      step = '2 GitHub check (sha)';
      const getUrl = `${apiBase}/${remotePath}?ref=${encodeURIComponent(s.githubBranch)}`;
      const getRes = await this.githubFetch('GET', getUrl);
      let sha = null;
      if (getRes.status === 200) {
        sha = getRes.json.sha;
        console.log('[JBT-BG] 2. existing sha:', sha);
      } else if (getRes.status === 404) {
        console.log('[JBT-BG] 2. file does not exist yet → will create');
      } else {
        throw new Error(`GET ${getRes.status}: ${getRes.text.slice(0, 200)}`);
      }

      // 3. Upload/replace (sha required only when updating).
      step = '3 GitHub upload';
      const payload = {
        message: `Update ${mode} wallpaper (${new Date().toISOString()})`,
        content,
        branch: s.githubBranch,
      };
      if (sha) payload.sha = sha;
      const putRes = await this.githubFetch('PUT', `${apiBase}/${remotePath}`, payload);
      if (putRes.status < 200 || putRes.status >= 300) {
        throw new Error(`PUT ${putRes.status}: ${putRes.text.slice(0, 200)}`);
      }
      console.log('[JBT-BG] 3. uploaded →', fixedFile);

      // 4. Bump ?v=N before writing the snippet (beats Obsidian's 7-day cache).
      step = '4 save version';
      s.versionCounter = (s.versionCounter || 0) + 1;
      await this.saveSettings();
      console.log('[JBT-BG] 4. versionCounter →', s.versionCounter);

      // 5. Purge jsDelivr (clears the 12h CDN cache). Non-fatal, but notified.
      step = '5 purge CDN';
      const purgeUrl = `https://purge.jsdelivr.net/gh/${s.githubOwner}/${s.githubRepo}@${s.githubBranch}/${remotePath}`;
      let purgeFailed = false;
      try {
        const purgeRes = await requestUrl({ url: purgeUrl, throw: false });
        if (purgeRes.status >= 200 && purgeRes.status < 300) {
          console.log(`[JBT-BG] 5. purge OK ${purgeRes.status}:`, purgeRes.text.trim().slice(0, 80));
        } else {
          purgeFailed = true;
          console.warn(`[JBT-BG] 5. purge HTTP ${purgeRes.status}:`, purgeRes.text.trim().slice(0, 80));
        }
      } catch (e) {
        purgeFailed = true;
        console.warn('[JBT-BG] 5. purge failed:', e);
      }
      if (purgeFailed) {
        await copyText(purgeUrl);
        console.log('[JBT-BG] 5. purge URL copied to clipboard — open manually:', purgeUrl);
        new Notice('Step 5 (purge CDN) failed — purge URL copied to clipboard. Open it in a browser to refresh.');
      }

      // 6. Write the CSS snippet (survives theme updates).
      step = '6 write snippet';
      await this.writeSnippet();
      console.log('[JBT-BG] 6. snippet written:', SNIPPET_PATH);

      // 7. Enable the snippet.
      step = '7 enable snippet';
      await this.app.customCss.setCssEnabledStatus(SNIPPET_ID, true);
      console.log('[JBT-BG] 7. snippet enabled');

      // 8. Reload CSS.
      step = '8 reload CSS';
      this.app.customCss.requestLoadSnippets();
      this.app.workspace.trigger('css-change');
      console.log('[JBT-BG] 8. snippets reloaded');

      // 9. Done.
      step = '9 done';
      const fullUrl = `https://cdn.jsdelivr.net/gh/${s.githubOwner}/${s.githubRepo}@${s.githubBranch}/${remotePath}?v=${s.versionCounter}`;
      console.log('[JBT-BG] 9. done → URL:', fullUrl);
      new Notice(`Wallpaper updated (${mode})`);
    } catch (e) {
      console.error(`[JBT-BG] failed at step ${step}:`, e);
      new Notice(`Wallpaper update failed at step ${step} — see console`);
    }
  }
}

module.exports = JBTBGPlugin;

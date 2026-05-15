<template>
  <main class="app-shell">
    <header class="topbar">
      <div class="brand">
        <img class="brand-icon" src="/app-icon.png" alt="" />
        <div>
          <p class="eyebrow">Clero</p>
          <h1>Local Agent</h1>
        </div>
      </div>

      <div v-if="hasConnection" class="runtime-control">
        <div class="connection-chip" :data-state="connectionPillState">
          <span></span>
          {{ connectionLabel }}
        </div>
        <button
          class="power-button"
          type="button"
          :data-running="daemonStatus.running"
          :disabled="powerButtonDisabled"
          @click="toggleDaemon"
        >
          {{ powerButtonLabel }}
        </button>
      </div>
    </header>

    <section v-if="developerMode" class="developer-screen">
      <div class="screen-heading">
        <div>
          <p class="eyebrow">For developers</p>
          <h2>Runtime logs</h2>
        </div>
        <button class="secondary" type="button" @click="refreshStatus">Refresh</button>
      </div>

      <dl class="status-grid">
        <div>
          <dt>Connection</dt>
          <dd>{{ connectionLabel }}</dd>
        </div>
        <div>
          <dt>Process</dt>
          <dd>{{ daemonStatus.pid ? `PID ${daemonStatus.pid}` : "No process" }}</dd>
        </div>
        <div>
          <dt>Task</dt>
          <dd>{{ taskActivityLabel }}</dd>
        </div>
        <div>
          <dt>Last exit</dt>
          <dd>{{ daemonStatus.last_exit_code ?? "none" }}</dd>
        </div>
      </dl>

      <section class="update-panel">
        <div class="section-title">
          <div>
            <p class="eyebrow">Updates</p>
            <h3>{{ updateTitle }}</h3>
          </div>
        </div>
        <p>{{ updateDetail }}</p>
        <div v-if="updateProgressLabel" class="update-progress">
          <span :style="{ width: updateProgressPercent }"></span>
        </div>
        <div class="update-actions">
          <button
            class="secondary"
            type="button"
            :disabled="updateBusy"
            @click="checkForUpdates(false)"
          >
            Check
          </button>
          <button
            v-if="updateState === 'available'"
            class="primary"
            type="button"
            :disabled="updateBusy"
            @click="checkForUpdates(true)"
          >
            Update
          </button>
        </div>
      </section>

      <section class="log-panel">
        <div class="section-title">
          <div>
            <p class="eyebrow">Daemon</p>
            <h3>Recent output</h3>
          </div>
        </div>
        <pre>{{ daemonLog }}</pre>
      </section>

      <details class="config-panel">
        <summary>Raw configuration</summary>
        <pre>{{ JSON.stringify(config, null, 2) }}</pre>
      </details>
    </section>

    <section v-else-if="!hasConnection" class="pairing-screen">
      <section class="pairing-panel">
        <div class="pairing-copy">
          <p class="eyebrow">Connect Clero</p>
          <h2>Enter your connection code.</h2>
        </div>

        <div class="pairing-form">
          <input
            v-model="pairingCode"
            autocomplete="one-time-code"
            placeholder="LRA-0000-0000-0000"
            spellcheck="false"
            @keyup.enter="pairRuntime"
          />
          <button class="primary" type="button" :disabled="connectionState === 'pairing'" @click="pairRuntime">
            {{ pairingButtonLabel }}
          </button>
        </div>

        <button
          v-if="pairingHasCode || advancedConnectionOpen"
          class="text-link light"
          type="button"
          @click="advancedConnectionOpen = !advancedConnectionOpen"
        >
          {{ advancedConnectionOpen ? "Hide advanced settings" : "Advanced settings" }}
        </button>

        <Transition name="expand">
          <div v-if="advancedConnectionOpen" class="advanced-connection">
            <label>
              Device name
              <input v-model="config.device_name" />
            </label>
          </div>
        </Transition>
      </section>
    </section>

    <section v-else class="runtime-screen">
      <section class="runtime-summary">
        <div>
          <p class="eyebrow">This computer</p>
          <h2>{{ config.device_name || "Local computer" }}</h2>
          <p>{{ connectionHost }}</p>
        </div>

        <div class="activity-card" :data-state="activityState">
          <span></span>
          <div>
            <strong>{{ taskActivityLabel }}</strong>
            <small>{{ taskActivityDetail }}</small>
          </div>
        </div>
      </section>

      <section class="capability-stack" aria-label="Local capabilities">
        <article
          class="capability-card"
          :data-open="isCapabilityOpen('browser')"
          :data-enabled="browserEnabled"
          :data-unavailable="browserUnavailable"
        >
          <div class="capability-header">
            <button
              class="capability-toggle"
              type="button"
              :aria-expanded="isCapabilityOpen('browser')"
              aria-controls="browser-settings"
              @click="toggleCapability('browser')"
            >
              <span class="capability-copy">
                <span class="capability-name">Browser</span>
                <span class="capability-status">{{ browserStatusText }}</span>
              </span>
              <span class="capability-chevron" aria-hidden="true"></span>
            </button>
            <label class="switch" @click.stop>
              <input v-model="browserEnabled" type="checkbox" :disabled="browserUnavailable" />
              <span></span>
            </label>
          </div>

          <Transition name="capability-expand">
            <div v-if="isCapabilityOpen('browser')" id="browser-settings" class="capability-settings">
              <label>
                Browser
                <select v-model="config.capabilities.browser.browser_channel">
                  <option value="chrome">Chrome</option>
                  <option value="chromium">Chromium</option>
                  <option value="chrome-beta">Chrome Beta</option>
                  <option value="msedge">Edge</option>
                </select>
              </label>
              <label class="wide">
                Browser profile
                <input
                  v-model="config.capabilities.browser.browser_profile_dir"
                  spellcheck="false"
                  placeholder="Default managed profile"
                />
              </label>
            </div>
          </Transition>
        </article>

        <article
          class="capability-card"
          :data-open="isCapabilityOpen('coding')"
          :data-enabled="codexEnabled"
          :data-unavailable="codexUnavailable"
        >
          <div class="capability-header">
            <button
              class="capability-toggle"
              type="button"
              :aria-expanded="isCapabilityOpen('coding')"
              aria-controls="coding-settings"
              @click="toggleCapability('coding')"
            >
              <span class="capability-copy">
                <span class="capability-name">Coding agent</span>
                <span class="capability-status">{{ codexStatusText }}</span>
              </span>
              <span class="capability-chevron" aria-hidden="true"></span>
            </button>
            <label class="switch" @click.stop>
              <input v-model="codexEnabled" type="checkbox" :disabled="codexUnavailable" />
              <span></span>
            </label>
          </div>

          <Transition name="capability-expand">
            <div v-if="isCapabilityOpen('coding')" id="coding-settings" class="capability-settings">
            <label class="wide">
              Agent
              <select v-model="config.capabilities.codex.provider">
                <option value="codex">Codex</option>
                <option value="claude-code">Claude Code</option>
              </select>
            </label>

            <template v-if="config.capabilities.codex.provider === 'codex'">
              <label class="wide">
                Codex command
                <input v-model="config.capabilities.codex.command" spellcheck="false" placeholder="Auto-detected" />
              </label>
              <label>
                Model
                <select v-model="config.capabilities.codex.model">
                  <option value="">Auto</option>
                  <option value="gpt-5.5">GPT-5.5</option>
                  <option value="gpt-5.4">GPT-5.4</option>
                  <option value="gpt-5.4-mini">GPT-5.4 Mini</option>
                  <option value="gpt-5.3-codex">GPT-5.3 Codex</option>
                  <option value="gpt-5.3-codex-spark">GPT-5.3 Codex Spark</option>
                  <option value="gpt-5.2">GPT-5.2</option>
                </select>
              </label>
              <label>
                Reasoning
                <select v-model="config.capabilities.codex.reasoning_effort">
                  <option value="">Auto</option>
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                  <option value="xhigh">Extra high</option>
                </select>
              </label>
              <label>
                Sandbox
                <select v-model="config.capabilities.codex.default_sandbox">
                  <option value="read-only">Read only</option>
                  <option value="workspace-write">Workspace write</option>
                  <option value="danger-full-access">Danger full access</option>
                </select>
              </label>
            </template>

            <template v-else>
              <label class="wide">
                Claude command
                <input v-model="config.capabilities.codex.claude_command" spellcheck="false" placeholder="Auto-detected" />
              </label>
              <label>
                Model
                <select v-model="config.capabilities.codex.claude_model">
                  <option value="">Auto</option>
                  <option value="default">Default</option>
                  <option value="best">Best</option>
                  <option value="sonnet">Sonnet</option>
                  <option value="opus">Opus</option>
                  <option value="opusplan">Opus Plan + Sonnet Execute</option>
                  <option value="haiku">Haiku</option>
                  <option value="sonnet[1m]">Sonnet 1M Context</option>
                  <option value="opus[1m]">Opus 1M Context</option>
                  <option value="custom">Custom</option>
                </select>
              </label>
              <label v-if="config.capabilities.codex.claude_model === 'custom'" class="wide">
                Custom model
                <input
                  v-model="config.capabilities.codex.claude_model_custom"
                  spellcheck="false"
                  placeholder="claude-sonnet-4-5"
                />
              </label>
              <label>
                Effort
                <select v-model="config.capabilities.codex.claude_reasoning_effort">
                  <option value="">Auto</option>
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                  <option value="xhigh">Extra high</option>
                  <option value="max">Max</option>
                </select>
              </label>
              <label>
                Permissions
                <select v-model="config.capabilities.codex.claude_permission_mode">
                  <option value="default">Default</option>
                  <option value="plan">Plan</option>
                  <option value="acceptEdits">Accept edits</option>
                  <option value="auto">Auto</option>
                  <option value="dontAsk">Don't ask</option>
                </select>
              </label>
            </template>

            <label class="check wide">
              <input v-model="config.capabilities.codex.allow_danger_full_access" type="checkbox" />
              Allow full local access
            </label>

            <div class="folder-tools wide">
              <div class="folder-tools-header">
                <div>
                  <p class="eyebrow">Projects</p>
                  <h4>Allowed folders</h4>
                </div>
                <button class="secondary compact" type="button" @click.stop="chooseFolder">Choose Folder</button>
              </div>

              <div v-if="config.allowed_directories.length" class="folder-list">
                <article v-for="folder in config.allowed_directories" :key="folder">
                  <div>
                    <strong>{{ folderName(folder) }}</strong>
                    <code>{{ folder }}</code>
                  </div>
                  <button type="button" @click.stop="removeFolder(folder)">Remove</button>
                </article>
              </div>

              <div v-else class="empty-state">
                <strong>No folders selected.</strong>
                <span>Coding agents stay read-only until a project folder is allowed.</span>
              </div>

              <div class="manual-folder">
                <input v-model="manualFolder" placeholder="/Users/me/Projects/app" spellcheck="false" @click.stop />
                <button type="button" @click.stop="addManualFolder">Add</button>
              </div>
            </div>
            </div>
          </Transition>
        </article>

        <article
          class="capability-card"
          :data-open="isCapabilityOpen('git')"
          :data-enabled="config.capabilities.git.read_enabled || writeAccessEnabled"
          :data-unavailable="writeActionsUnavailable"
        >
          <div class="capability-header">
            <button
              class="capability-toggle"
              type="button"
              :aria-expanded="isCapabilityOpen('git')"
              aria-controls="git-settings"
              @click="toggleCapability('git')"
            >
              <span class="capability-copy">
                <span class="capability-name">Git</span>
                <span class="capability-status">{{ gitStatusText }}</span>
              </span>
              <span class="capability-chevron" aria-hidden="true"></span>
            </button>
            <label class="switch" @click.stop>
              <input v-model="config.capabilities.git.read_enabled" type="checkbox" />
              <span></span>
            </label>
          </div>

          <Transition name="capability-expand">
            <div v-if="isCapabilityOpen('git')" id="git-settings" class="capability-settings">
              <label class="check wide">
                <input v-model="config.capabilities.git.read_enabled" type="checkbox" />
                Status and diff
              </label>
              <label class="check wide">
                <input v-model="writeAccessEnabled" type="checkbox" :disabled="writeActionsUnavailable" />
                Commit and push with approval
              </label>
            </div>
          </Transition>
        </article>
      </section>

      <div class="runtime-actions">
        <button class="primary" type="button" @click="saveConfig">Save changes</button>
        <button class="secondary" type="button" @click="refreshStatus">Refresh checks</button>
        <button class="text-link danger" type="button" @click="removeConnection">Remove connection</button>
      </div>
    </section>

    <button class="developer-link" type="button" @click="developerMode = !developerMode">
      {{ developerMode ? "Back" : "For developers" }}
    </button>

    <Transition name="toast">
      <p v-if="notice" class="notice">{{ notice }}</p>
    </Transition>
  </main>
</template>

<script setup lang="ts">
type ConnectionState = "offline" | "connected" | "pairing";
type CapabilityPanel = "browser" | "coding" | "git";
type UpdateState = "idle" | "checking" | "available" | "current" | "installing" | "restarting" | "error";

const PRODUCTION_BACKEND_URL = "https://clero.so";

type RuntimeConfig = {
  backend_url: string;
  websocket_url: string;
  device_token: string;
  device_name: string;
  allowed_directories: string[];
  capabilities: {
    browser: {
      enabled: boolean;
      provider: "managed" | "mcp-chrome";
      browser_channel: "chromium" | "chrome" | "chrome-beta" | "msedge";
      browser_profile_dir: string;
      browser_headless: boolean;
      mcp_url?: string;
    };
    workspace: {
      enabled: boolean;
    };
    codex: {
      enabled: boolean;
      provider: "codex" | "claude-code";
      command: string;
      model: string;
      reasoning_effort: "" | "low" | "medium" | "high" | "xhigh";
      claude_command: string;
      claude_model: string;
      claude_model_custom: string;
      claude_reasoning_effort: "" | "low" | "medium" | "high" | "xhigh" | "max";
      claude_permission_mode: "default" | "acceptEdits" | "plan" | "auto" | "dontAsk" | "bypassPermissions";
      default_sandbox: "read-only" | "workspace-write" | "danger-full-access";
      allow_workspace_write: boolean;
      allow_danger_full_access: boolean;
    };
    git: {
      read_enabled: boolean;
      write_enabled: boolean;
    };
  };
};

type DaemonStatus = {
  running: boolean;
  pid: number | null;
  last_exit_code: number | null;
  log_tail: string[];
};

type DependencyCheck = {
  available: boolean;
  label: string;
  path: string | null;
  version: string | null;
  message: string;
};

type DependencyStatus = {
  browser: DependencyCheck;
  codex: DependencyCheck;
  claude: DependencyCheck;
};

const connectionState = ref<ConnectionState>("offline");
const pairingCode = ref("");
const manualFolder = ref("");
const notice = ref("");
const config = reactive<RuntimeConfig>(defaultConfig());
const daemonStatus = reactive<DaemonStatus>(defaultDaemonStatus());
const dependencyStatus = reactive<DependencyStatus>(defaultDependencyStatus());
const dependenciesChecked = ref(false);
const advancedConnectionOpen = ref(false);
const developerMode = ref(false);
const activeCapability = ref<CapabilityPanel | null>("browser");
const updateState = ref<UpdateState>("idle");
const updateVersion = ref("");
const updateMessage = ref("");
const updateDownloaded = ref(0);
const updateTotal = ref(0);
let daemonStatusTimer: ReturnType<typeof setInterval> | undefined;

const connectionLabel = computed(() => {
  if (connectionState.value === "pairing") return "Connecting";
  if (daemonStatus.running) return "Online";
  if (config.device_token && config.websocket_url) return "Paired";
  if (connectionState.value === "connected") return "Connected";
  return "Offline";
});

const connectionPillState = computed(() => {
  if (connectionState.value === "pairing") return "pairing";
  if (daemonStatus.running || (config.device_token && config.websocket_url)) return "connected";
  return "offline";
});

const pairingButtonLabel = computed(() => {
  if (connectionState.value === "pairing") return "Connecting";
  return "Connect";
});

const pairingHasCode = computed(() => pairingCode.value.trim().length > 0);

const hasConnection = computed(() => Boolean(config.device_token || config.websocket_url));

const powerButtonDisabled = computed(() => connectionState.value === "pairing" || (!hasConnection.value && !daemonStatus.running));

const powerButtonLabel = computed(() => {
  if (connectionState.value === "pairing") return "Connecting";
  return daemonStatus.running ? "Turn off" : "Turn on";
});

const connectionHost = computed(() => {
  return new URL(PRODUCTION_BACKEND_URL).host;
});

const browserUnavailable = computed(() => dependenciesChecked.value && !dependencyStatus.browser.available);

const selectedCodingDependency = computed(() =>
  config.capabilities.codex.provider === "claude-code" ? dependencyStatus.claude : dependencyStatus.codex
);

const codexUnavailable = computed(() => dependenciesChecked.value && !selectedCodingDependency.value.available);

const writeActionsUnavailable = computed(() => codexUnavailable.value);

const browserEnabled = computed({
  get: () => config.capabilities.browser.enabled && !browserUnavailable.value,
  set: (enabled: boolean) => {
    if (enabled && browserUnavailable.value) {
      notice.value = dependencyStatus.browser.message;
      return;
    }
    config.capabilities.browser.enabled = enabled;
  }
});

const codexEnabled = computed({
  get: () => config.capabilities.codex.enabled && !codexUnavailable.value,
  set: (enabled: boolean) => {
    if (enabled && codexUnavailable.value) {
      notice.value = selectedCodingDependency.value.message;
      return;
    }
    config.capabilities.codex.enabled = enabled;
  }
});

const writeAccessEnabled = computed({
  get: () =>
    !writeActionsUnavailable.value &&
    (config.capabilities.codex.allow_workspace_write || config.capabilities.git.write_enabled),
  set: (enabled: boolean) => {
    if (enabled && writeActionsUnavailable.value) {
      notice.value = selectedCodingDependency.value.message;
      return;
    }
    config.capabilities.codex.allow_workspace_write = enabled;
    config.capabilities.git.write_enabled = enabled;
    if (enabled) {
      config.capabilities.codex.enabled = true;
      if (config.capabilities.codex.provider === "claude-code") {
        config.capabilities.codex.claude_permission_mode = "acceptEdits";
      } else {
        config.capabilities.codex.default_sandbox = "workspace-write";
      }
    } else {
      if (config.capabilities.codex.default_sandbox === "workspace-write") {
        config.capabilities.codex.default_sandbox = "read-only";
      }
      if (config.capabilities.codex.claude_permission_mode === "acceptEdits") {
        config.capabilities.codex.claude_permission_mode = "default";
      }
    }
  }
});

const isCapabilityOpen = (panel: CapabilityPanel) => activeCapability.value === panel;

const toggleCapability = (panel: CapabilityPanel) => {
  activeCapability.value = isCapabilityOpen(panel) ? null : panel;
};

const browserStatusText = computed(() => {
  if (browserUnavailable.value) return dependencyStatus.browser.message;
  return dependencyStatus.browser.path ? `${dependencyStatus.browser.label} ready` : "Managed Chrome browsing";
});

const codexStatusText = computed(() => {
  if (codexUnavailable.value) return selectedCodingDependency.value.message;
  if (selectedCodingDependency.value.version) return selectedCodingDependency.value.version;
  return config.capabilities.codex.provider === "claude-code" ? "Claude Code tasks in allowed folders" : "Codex tasks in allowed folders";
});

const codingProviderLabel = computed(() =>
  config.capabilities.codex.provider === "claude-code" ? "Claude Code" : "Codex"
);

const enabledToolGroups = computed(() => {
  const groups: string[] = [];
  if (browserEnabled.value) groups.push("Browser");
  if (codexEnabled.value) groups.push(codingProviderLabel.value);
  if (writeAccessEnabled.value) groups.push("Write");
  return groups;
});

const gitStatusText = computed(() => {
  if (!config.capabilities.git.read_enabled) return "Disabled";
  if (writeAccessEnabled.value) return "Status, diff, commit, and push";
  return "Status and diff only";
});

const recentDaemonLog = computed(() => daemonStatus.log_tail.slice(-80).join("\n"));

const taskRunning = computed(() => {
  if (!daemonStatus.running) return false;
  const text = recentDaemonLog.value;
  const lastStart = lastIndexOfAny(text, [
    '"tool":"coding_agent.start_task"',
    '"last_event_type":"process.started"',
    '"status":"running"'
  ]);
  const lastFinish = lastIndexOfAny(text, [
    '"status":"completed"',
    '"status":"failed"',
    '"status":"cancelled"',
    '"last_event_type":"process.exited"',
    '"last_event_type":"process.exit"',
    '"finished_at":"'
  ]);
  return lastStart >= 0 && lastStart > lastFinish;
});

const taskActivityLabel = computed(() => {
  if (taskRunning.value) return "Task running";
  if (daemonStatus.running) return "Ready";
  return "Off";
});

const activityState = computed(() => {
  if (taskRunning.value) return "running";
  if (daemonStatus.running) return "ready";
  return "off";
});

const taskActivityDetail = computed(() => {
  if (taskRunning.value) return "A local coding task is still active.";
  if (daemonStatus.running) return enabledToolGroups.value.length ? `${enabledToolGroups.value.join(", ")} enabled` : "No capabilities enabled";
  return hasConnection.value ? "Turn on the runtime to accept requests." : "Connect this computer first.";
});

const daemonLog = computed(() => daemonStatus.log_tail.join("\n") || "No daemon logs yet.");

const updateBusy = computed(() =>
  updateState.value === "checking" || updateState.value === "installing" || updateState.value === "restarting"
);

const updateTitle = computed(() => {
  if (updateState.value === "checking") return "Checking for updates";
  if (updateState.value === "available") return `Version ${updateVersion.value} available`;
  if (updateState.value === "current") return "App is up to date";
  if (updateState.value === "installing") return "Installing update";
  if (updateState.value === "restarting") return "Restarting";
  if (updateState.value === "error") return "Update check failed";
  return "App updates";
});

const updateProgressLabel = computed(() => {
  if (updateState.value !== "installing" || updateTotal.value <= 0) return "";
  return `${Math.round((updateDownloaded.value / updateTotal.value) * 100)}%`;
});

const updateProgressPercent = computed(() => updateProgressLabel.value || "0%");

const updateDetail = computed(() => {
  if (updateMessage.value) return updateMessage.value;
  if (updateState.value === "available") return "Download and restart to apply the latest GitHub release.";
  if (updateState.value === "installing") return updateProgressLabel.value ? `Downloading ${updateProgressLabel.value}` : "Downloading update.";
  if (updateState.value === "restarting") return "The app will reopen after the update is installed.";
  return "Updates are delivered through signed GitHub release artifacts.";
});

onMounted(async () => {
  try {
    const loaded = await invokeTauri<RuntimeConfig>("load_config");
    applyRuntimeConfig(loaded);
  } catch {
    notice.value = "Using local defaults.";
    forceProductionConnectionConfig();
  }
  await refreshDependencyStatus();
  applyDependencyAvailability();
  await refreshDaemonStatus();
  daemonStatusTimer = setInterval(() => {
    void refreshDaemonStatus();
  }, 2500);
});

onBeforeUnmount(() => {
  if (daemonStatusTimer) {
    clearInterval(daemonStatusTimer);
  }
});

async function saveConfig(showNotice = true): Promise<void> {
  try {
    forceProductionConnectionConfig();
    applyDependencyAvailability(true);
    const saved = await invokeTauri<RuntimeConfig>("save_config", { config: toRaw(config) });
    applyRuntimeConfig(saved);
    if (showNotice) {
      notice.value = "Settings saved.";
    }
  } catch {
    forceProductionConnectionConfig();
    localStorage.setItem("clero-local-agent-config", JSON.stringify(toRaw(config)));
    if (showNotice) {
      notice.value = "Settings saved in browser storage.";
    }
  }
}

async function checkForUpdates(install: boolean): Promise<void> {
  if (!("__TAURI_INTERNALS__" in window)) {
    updateState.value = "error";
    updateMessage.value = "Updates are only available in the installed desktop app.";
    return;
  }

  updateState.value = "checking";
  updateMessage.value = "";
  updateVersion.value = "";
  updateDownloaded.value = 0;
  updateTotal.value = 0;

  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();
    if (!update) {
      updateState.value = "current";
      updateMessage.value = "No update is available.";
      return;
    }

    updateState.value = "available";
    updateVersion.value = update.version;
    updateMessage.value = update.body || "A new signed release is available.";

    if (!install) return;

    updateState.value = "installing";
    updateMessage.value = "";
    await update.downloadAndInstall((event) => {
      if (event.event === "Started") {
        updateTotal.value = event.data.contentLength ?? 0;
      }
      if (event.event === "Progress") {
        updateDownloaded.value += event.data.chunkLength;
      }
    });

    updateState.value = "restarting";
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  } catch (error) {
    updateState.value = "error";
    updateMessage.value = errorMessage(error);
  }
}

async function pairRuntime(): Promise<void> {
  const code = pairingCode.value.trim();
  if (!code) {
    notice.value = "Pairing code is required.";
    return;
  }
  if (hasConnection.value) {
    notice.value = "Remove the existing connection before adding a new one.";
    return;
  }

  connectionState.value = "pairing";
  try {
    forceProductionConnectionConfig();
    await refreshDependencyStatus();
    applyDependencyAvailability(true);
    const paired = await invokeTauri<RuntimeConfig>("pair_runtime", { code, config: toRaw(config) });
    applyRuntimeConfig(paired);
    pairingCode.value = "";
    advancedConnectionOpen.value = false;
    connectionState.value = "connected";
    notice.value = "Runtime paired.";
    await startDaemon(false);
  } catch (error) {
    await saveConfig();
    connectionState.value = "offline";
    notice.value = errorMessage(error);
  }
}

async function startDaemon(saveFirst = true): Promise<void> {
  try {
    await refreshDependencyStatus();
    applyDependencyAvailability(true);
    if (saveFirst) {
      await saveConfig(false);
    }
    const status = await invokeTauri<DaemonStatus>("start_daemon", { config: toRaw(config) });
    applyDaemonStatus(status);
  } catch (error) {
    notice.value = errorMessage(error);
  }
}

async function stopDaemon(): Promise<void> {
  try {
    const status = await invokeTauri<DaemonStatus>("stop_daemon");
    applyDaemonStatus(status);
  } catch (error) {
    notice.value = errorMessage(error);
  }
}

async function toggleDaemon(): Promise<void> {
  if (daemonStatus.running) {
    await stopDaemon();
    return;
  }
  if (!hasConnection.value) {
    notice.value = "Connect this computer before turning on the runtime.";
    return;
  }
  await startDaemon();
}

async function removeConnection(): Promise<void> {
  try {
    if (daemonStatus.running) {
      const status = await invokeTauri<DaemonStatus>("stop_daemon");
      applyDaemonStatus(status);
    }
  } catch {
    applyDaemonStatus(defaultDaemonStatus());
  }

  config.device_token = "";
  config.websocket_url = "";
  pairingCode.value = "";
  developerMode.value = false;
  connectionState.value = "offline";
  await saveConfig();
  notice.value = "Connection removed.";
}

async function refreshDaemonStatus(): Promise<void> {
  try {
    const status = await invokeTauri<DaemonStatus>("daemon_status");
    applyDaemonStatus(status);
  } catch {
    applyDaemonStatus(defaultDaemonStatus());
  }
}

async function refreshDependencyStatus(): Promise<void> {
  try {
    const status = await invokeTauri<DependencyStatus>("check_dependencies", { config: toRaw(config) });
    Object.assign(dependencyStatus.browser, status.browser);
    Object.assign(dependencyStatus.codex, status.codex);
    Object.assign(dependencyStatus.claude, status.claude);
    dependenciesChecked.value = true;
    if (status.codex.available && status.codex.path && !config.capabilities.codex.command) {
      config.capabilities.codex.command = status.codex.path;
    }
    if (status.claude.available && status.claude.path && !config.capabilities.codex.claude_command) {
      config.capabilities.codex.claude_command = status.claude.path;
    }
  } catch {
    dependenciesChecked.value = false;
  }
}

async function refreshStatus(): Promise<void> {
  await refreshDependencyStatus();
  applyDependencyAvailability();
  await refreshDaemonStatus();
}

function applyDependencyAvailability(showNotice = false): void {
  const disabled: string[] = [];
  if (browserUnavailable.value && config.capabilities.browser.enabled) {
    config.capabilities.browser.enabled = false;
    disabled.push("Browser");
  }
  if (codexUnavailable.value && config.capabilities.codex.enabled) {
    config.capabilities.codex.enabled = false;
    disabled.push(codingProviderLabel.value);
  }
  if (writeActionsUnavailable.value && (config.capabilities.codex.allow_workspace_write || config.capabilities.git.write_enabled)) {
    config.capabilities.codex.allow_workspace_write = false;
    config.capabilities.git.write_enabled = false;
    disabled.push("Write actions");
  }
  if (showNotice && disabled.length > 0) {
    notice.value = `Disabled unavailable tools: ${disabled.join(", ")}.`;
  }
}

function applyDaemonStatus(status: DaemonStatus): void {
  Object.assign(daemonStatus, {
    running: status.running,
    pid: status.pid ?? null,
    last_exit_code: status.last_exit_code ?? null,
    log_tail: status.log_tail ?? []
  });
}

async function chooseFolder(): Promise<void> {
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === "string") {
      addFolder(selected);
    }
  } catch {
    notice.value = "Folder picker is available inside the desktop shell.";
  }
}

function addManualFolder(): void {
  addFolder(manualFolder.value);
  manualFolder.value = "";
}

function addFolder(folder: string): void {
  const normalized = folder.trim();
  if (!normalized || config.allowed_directories.includes(normalized)) {
    return;
  }
  config.allowed_directories.push(normalized);
}

function removeFolder(folder: string): void {
  config.allowed_directories = config.allowed_directories.filter((item) => item !== folder);
}

function folderName(folder: string): string {
  return folder.split(/[\\/]/).filter(Boolean).at(-1) ?? folder;
}

function applyRuntimeConfig(nextConfig: RuntimeConfig): void {
  Object.assign(config, normalizeLoadedConfig(nextConfig));
}

function normalizeLoadedConfig(nextConfig: RuntimeConfig): RuntimeConfig {
  const normalized = nextConfig;
  const backendWasLocal = isLocalEndpoint(normalized.backend_url);
  normalized.backend_url = PRODUCTION_BACKEND_URL;
  normalized.capabilities.browser.provider = "managed";
  normalized.capabilities.browser.mcp_url = undefined;

  if (backendWasLocal || isLocalEndpoint(normalized.websocket_url)) {
    normalized.websocket_url = "";
    normalized.device_token = "";
  }

  return normalized;
}

function forceProductionConnectionConfig(): void {
  const backendWasLocal = isLocalEndpoint(config.backend_url);
  config.backend_url = PRODUCTION_BACKEND_URL;
  config.capabilities.browser.provider = "managed";
  config.capabilities.browser.mcp_url = undefined;

  if (backendWasLocal || isLocalEndpoint(config.websocket_url)) {
    config.websocket_url = "";
    config.device_token = "";
  }
}

function isLocalEndpoint(value: string | undefined): boolean {
  const normalized = (value ?? "").trim().toLowerCase();
  return (
    normalized.includes("localhost") ||
    normalized.includes("127.0.0.1") ||
    normalized.includes("0.0.0.0") ||
    normalized.includes("[::1]")
  );
}

async function invokeTauri<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!("__TAURI_INTERNALS__" in window)) {
    const saved = localStorage.getItem("clero-local-agent-config");
    if (command === "load_config" && saved) {
      return normalizeLoadedConfig(JSON.parse(saved) as RuntimeConfig) as T;
    }
    throw new Error("Tauri runtime is not available");
  }

  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
}

function defaultConfig(): RuntimeConfig {
  return {
    backend_url: PRODUCTION_BACKEND_URL,
    websocket_url: "",
    device_token: "",
    device_name: "Local Mac",
    allowed_directories: [],
    capabilities: {
      browser: {
        enabled: true,
        provider: "managed",
        browser_channel: "chrome",
        browser_profile_dir: "",
        browser_headless: false
      },
      workspace: {
        enabled: true
      },
      codex: {
        enabled: false,
        provider: "codex",
        command: "",
        model: "",
        reasoning_effort: "",
        claude_command: "",
        claude_model: "",
        claude_model_custom: "",
        claude_reasoning_effort: "",
        claude_permission_mode: "default",
        default_sandbox: "read-only",
        allow_workspace_write: false,
        allow_danger_full_access: false
      },
      git: {
        read_enabled: true,
        write_enabled: false
      }
    }
  };
}

function defaultDaemonStatus(): DaemonStatus {
  return {
    running: false,
    pid: null,
    last_exit_code: null,
    log_tail: []
  };
}

function defaultDependencyStatus(): DependencyStatus {
  return {
    browser: {
      available: true,
      label: "Google Chrome",
      path: null,
      version: null,
      message: "Browser availability has not been checked."
    },
    codex: {
      available: true,
      label: "Codex CLI",
      path: null,
      version: null,
      message: "Codex availability has not been checked."
    },
    claude: {
      available: true,
      label: "Claude Code",
      path: null,
      version: null,
      message: "Claude Code availability has not been checked."
    }
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === "string" ? error : "Desktop command failed.";
}

function lastIndexOfAny(text: string, values: string[]): number {
  return values.reduce((highest, value) => Math.max(highest, text.lastIndexOf(value)), -1);
}
</script>

import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface TokenStore {
  get(account: string): Promise<string | null>;
  set(account: string, token: string): Promise<void>;
  delete(account: string): Promise<void>;
}

export class MacOSKeychainTokenStore implements TokenStore {
  private readonly service: string;

  constructor(service = "clero-local-agent") {
    this.service = service;
  }

  async get(account: string): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync("security", ["find-generic-password", "-s", this.service, "-a", account, "-w"]);
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }

  async set(account: string, token: string): Promise<void> {
    await execFileAsync("security", [
      "add-generic-password",
      "-U",
      "-s",
      this.service,
      "-a",
      account,
      "-w",
      token
    ]);
  }

  async delete(account: string): Promise<void> {
    try {
      await execFileAsync("security", ["delete-generic-password", "-s", this.service, "-a", account]);
    } catch {
      return;
    }
  }
}

export class FileTokenStore implements TokenStore {
  private readonly directory: string;

  constructor(directory = path.join(os.homedir(), ".clero-local-agent")) {
    this.directory = directory;
  }

  async get(account: string): Promise<string | null> {
    try {
      return (await readFile(this.filePath(account), "utf8")).trim() || null;
    } catch {
      return null;
    }
  }

  async set(account: string, token: string): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await writeFile(this.filePath(account), token, { mode: 0o600 });
  }

  async delete(account: string): Promise<void> {
    await writeFile(this.filePath(account), "", { mode: 0o600 });
  }

  private filePath(account: string): string {
    return path.join(this.directory, `${encodeURIComponent(account)}.token`);
  }
}

export function createTokenStore(): TokenStore {
  if (process.platform === "darwin") {
    return new MacOSKeychainTokenStore();
  }

  return new FileTokenStore();
}

export interface SecretsConfig {
  projects: Record<string, ProjectConfig>;
}

export interface ProjectConfig {
  directory: string;
  whitelist?: WhitelistRule[];
  secrets?: Record<string, SecretProviderConfig>;
}

export interface WhitelistRule {
  command: string;
  file_hashes?: Record<string, string>;
  allowed_env?: string[];
  secrets?: string[];
}

export type SecretProviderConfig =
  | { provider: 'dotenv'; file: string; key?: string }
  | { provider: 'inline'; value: string }
  | { provider: 'command'; command: string; cwd?: string };

export interface ExecElevatedRequest {
  command: string;
  secrets: string[];
  env?: Record<string, string>;
  cwd?: string;
  project?: string;
}

export interface ExecElevatedOptions {
  configPath?: string;
  approveUnmatched?: boolean;
  baseEnv?: NodeJS.ProcessEnv;
}

export type ValidationStatus = 'allowed' | 'unmatched' | 'rejected';

export interface ValidationResult {
  status: ValidationStatus;
  projectName: string;
  project: ProjectConfig;
  matchedRule?: WhitelistRule;
  warning?: string;
  executablePaths: string[];
}

export interface ExecElevatedResult {
  ok: boolean;
  project: string;
  matchedRule?: string;
  approvedUnmatched?: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  warning?: string;
}

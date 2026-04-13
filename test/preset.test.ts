import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import semver from 'semver';

const PRESET_PATH = join(import.meta.dirname, '..', 'default.json');
const RENOVATE_BIN = join(import.meta.dirname, '..', 'node_modules', '.bin', 'renovate');

type DryRunMode = 'extract' | 'lookup';

interface PackageFiles {
    [manager: string]: Array<{
        packageFile: string;
        deps: Array<{
            depName: string;
            currentValue: string;
            updates?: Array<{
                newVersion?: string;
                newValue?: string;
                updateType?: string;
            }>;
            skipReason?: string;
            [key: string]: unknown;
        }>;
        [key: string]: unknown;
    }>;
}

describe('Renovate shared preset', () => {
    let repoDir: string;

    function doExec(cmd: string, opts: Record<string, unknown> = {}) {
        return execSync(cmd, { cwd: repoDir, ...opts });
    }

    function writeFiles(files: Record<string, string>) {
        for (const [relativePath, content] of Object.entries(files)) {
            const fullPath = join(repoDir, relativePath);
            mkdirSync(join(fullPath, '..'), { recursive: true });
            writeFileSync(fullPath, content);
        }
    }

    function commit(message = 'test commit') {
        doExec('git add -A');
        doExec(`git commit -m "${message}"`);
    }

    function presetConfig(): string {
        return readFileSync(PRESET_PATH, 'utf-8');
    }

    function runRenovate(mode: DryRunMode): PackageFiles {
        const reportPath = join(repoDir, 'report.json');

        try {
            doExec(
                [
                    RENOVATE_BIN,
                    '--platform=local',
                    `--dry-run=${mode}`,
                    '--report-type=file',
                    `--report-path=${reportPath}`,
                ].join(' '),
                {
                    // Renovate outputs a lot of noise at warn level; pipe to keep test output clean
                    stdio: 'pipe',
                    timeout: 120_000,
                    env: {
                        ...process.env,
                        LOG_LEVEL: 'warn',
                        RENOVATE_X_HARD_EXIT: 'true',
                    },
                },
            );
        } catch {
            // Renovate may exit non-zero but still write the report.
        }

        if (!existsSync(reportPath)) {
            throw new Error('Renovate did not produce a report file');
        }

        const report = JSON.parse(readFileSync(reportPath, 'utf-8'));
        return report?.repositories?.local?.packageFiles ?? {};
    }

    function findDep(packageFiles: PackageFiles, manager: string, depName: string) {
        for (const file of packageFiles[manager] ?? []) {
            const dep = file.deps.find((d) => d.depName === depName);
            if (dep) return dep;
        }
        return undefined;
    }

    beforeEach(() => {
        repoDir = mkdtempSync(join(tmpdir(), 'renovate-test-'));
        doExec('git init -b main');
        doExec('git config user.email "test@test.com"');
        doExec('git config user.name "Test"');
        doExec('git config commit.gpgsign false');
    });

    afterEach(() => {
        rmSync(repoDir, { recursive: true, force: true });
    });

    // -- extraction (fast, no network) --

    describe('extraction', () => {
        it('extracts Node.js version from .nvmrc', () => {
            writeFiles({
                'renovate.json': presetConfig(),
                '.nvmrc': '20.11.0\n',
            });
            commit();

            const result = runRenovate('extract');

            expect(result.nvm).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        packageFile: '.nvmrc',
                        deps: expect.arrayContaining([
                            expect.objectContaining({ depName: 'node', currentValue: '20.11.0' }),
                        ]),
                    }),
                ]),
            );
        });

        it('extracts package manager version from packageManager field', () => {
            writeFiles({
                'renovate.json': presetConfig(),
                'package.json': JSON.stringify({
                    name: 'test-packagemanager',
                    version: '1.0.0',
                    packageManager: 'pnpm@9.0.0',
                }, null, 2),
            });
            commit();

            const result = runRenovate('extract');

            expect(result.npm).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        packageFile: 'package.json',
                        deps: expect.arrayContaining([
                            expect.objectContaining({ depName: 'pnpm', currentValue: '9.0.0' }),
                        ]),
                    }),
                ]),
            );
        });

        it('extracts GitHub Actions versions from workflow files', () => {
            writeFiles({
                'renovate.json': presetConfig(),
                '.github/workflows/ci.yml': [
                    'name: CI',
                    'on: [push]',
                    'jobs:',
                    '  build:',
                    '    runs-on: ubuntu-latest',
                    '    steps:',
                    '      - uses: actions/checkout@v4',
                    '      - uses: actions/setup-node@v4',
                    '',
                ].join('\n'),
            });
            commit();

            const result = runRenovate('extract');

            expect(result['github-actions']).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        deps: expect.arrayContaining([
                            expect.objectContaining({ depName: 'actions/checkout', currentValue: 'v4' }),
                            expect.objectContaining({ depName: 'actions/setup-node', currentValue: 'v4' }),
                        ]),
                    }),
                ]),
            );
        });

        it('handles a repo with all managed files together', () => {
            writeFiles({
                'renovate.json': presetConfig(),
                '.nvmrc': '22.14.0\n',
                'package.json': JSON.stringify({
                    name: 'test-full',
                    version: '1.0.0',
                    packageManager: 'pnpm@9.0.0',
                    dependencies: { lodash: '^4.17.21' },
                }, null, 2),
                '.github/workflows/ci.yml': [
                    'name: CI',
                    'on: [push]',
                    'jobs:',
                    '  test:',
                    '    runs-on: ubuntu-latest',
                    '    steps:',
                    '      - uses: actions/checkout@v4',
                    '',
                ].join('\n'),
            });
            commit();

            const managers = Object.keys(runRenovate('extract'));

            expect(managers).toContain('nvm');
            expect(managers).toContain('npm');
            expect(managers).toContain('github-actions');
        });

        it('does not extract packageManager when field is absent', () => {
            writeFiles({
                'renovate.json': presetConfig(),
                'package.json': JSON.stringify({
                    name: 'test-no-packagemanager',
                    version: '1.0.0',
                    dependencies: { lodash: '^4.17.21' },
                }, null, 2),
            });
            commit();

            const result = runRenovate('extract');

            expect(result).toHaveProperty('npm');
            const packageManagerDeps = (result.npm ?? [])
                .flatMap((f) => f.deps)
                .filter((d) => d.depName === 'pnpm');
            expect(packageManagerDeps).toHaveLength(0);
        });
    });

    // -- lookup (queries registries, verifies updates are proposed) --

    describe('update lookup', () => {
        it('proposes a Node.js update for an outdated .nvmrc', () => {
            writeFiles({
                'renovate.json': presetConfig(),
                '.nvmrc': '18.0.0\n',
            });
            commit();

            const result = runRenovate('lookup');
            const dep = findDep(result, 'nvm', 'node');

            expect(dep).toBeDefined();
            expect(dep!.updates!.length).toBeGreaterThan(0);

            const newVersion = dep!.updates![0].newVersion!;
            expect(semver.valid(newVersion)).toBeTruthy();
            expect(semver.gt(newVersion, '18.0.0')).toBe(true);
        });

        it('proposes updates for outdated package.json dependencies', () => {
            writeFiles({
                'renovate.json': presetConfig(),
                'package.json': JSON.stringify({
                    name: 'test-old-deps',
                    version: '1.0.0',
                    dependencies: { express: '4.17.0' },
                    devDependencies: { typescript: '4.0.0' },
                }, null, 2),
            });
            commit();

            const result = runRenovate('lookup');

            const expressDep = findDep(result, 'npm', 'express');
            expect(expressDep).toBeDefined();
            expect(expressDep!.updates!.length).toBeGreaterThan(0);
            const expressNew = expressDep!.updates![0].newVersion!;
            expect(semver.valid(expressNew)).toBeTruthy();
            expect(semver.gt(expressNew, '4.17.0')).toBe(true);

            const tsDep = findDep(result, 'npm', 'typescript');
            expect(tsDep).toBeDefined();
            expect(tsDep!.updates!.length).toBeGreaterThan(0);
            const tsNew = tsDep!.updates![0].newVersion!;
            expect(semver.valid(tsNew)).toBeTruthy();
            expect(semver.gt(tsNew, '4.0.0')).toBe(true);
        });

        it('proposes a pnpm update for an outdated packageManager field', () => {
            writeFiles({
                'renovate.json': presetConfig(),
                'package.json': JSON.stringify({
                    name: 'test-old-pnpm',
                    version: '1.0.0',
                    packageManager: 'pnpm@9.0.0',
                }, null, 2),
            });
            commit();

            const result = runRenovate('lookup');
            const dep = findDep(result, 'npm', 'pnpm');

            expect(dep).toBeDefined();
            expect(dep!.updates!.length).toBeGreaterThan(0);

            const newVersion = dep!.updates![0].newVersion!;
            expect(semver.valid(newVersion)).toBeTruthy();
            expect(semver.gt(newVersion, '9.0.0')).toBe(true);
        });
    });
});

import fs from 'node:fs/promises';
import path from 'node:path';

import { normalizePath } from '@rollup/pluginutils';
import consola from 'consola';
import c from 'picocolors';
import { gt } from 'semver';
import type { RollupPlugin } from 'unplugin';
import { createUnplugin } from 'unplugin';
import { workspaceRoot } from 'workspace-root';

import { memoizeAsync, getPkgSize as _getPkgSize } from './utils';

export interface Options {
    fetchPkgInfoTimeout?: number;
}

const getWorkspaceRootFolder = memoizeAsync(async () => {
    let workspaceRootFolder = await workspaceRoot();
    if (workspaceRootFolder) {
        workspaceRootFolder = normalizePath(workspaceRootFolder);
    }
    return workspaceRootFolder;
});

const packagePathRegex = /.*\/node_modules\/(?:@[^/]+\/)?[^/]+/;
const getPackageInfo = memoizeAsync(async (id: string) => {
    id = normalizePath(id);
    const match = id.match(packagePathRegex);
    if (match) {
        const packageJsonPath = path.join(match[0], 'package.json');
        try {
            const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
            return {
                name: packageJson.name,
                version: packageJson.version,
            };
        } catch (error: any) {
            consola.warn(`can't read package.json of module id ${id} : ${error.message}`);
        }
    }
    return null;
});

const formatImporter = memoizeAsync(async (importer: string) => {
    importer = normalizePath(importer);

    let formattedImporter = importer;
    if (packagePathRegex.test(importer)) {
        const packageInfo = await getPackageInfo(importer);
        if (packageInfo) {
            formattedImporter = `${packageInfo.name}@${packageInfo.version}`;
        }
    }

    const workspaceRootFolder = await getWorkspaceRootFolder();
    if (workspaceRootFolder && formattedImporter.startsWith(workspaceRootFolder)) {
        return formattedImporter.slice(workspaceRootFolder.length + 1);
    }
    return formattedImporter;
});

const getPkgSize = memoizeAsync(_getPkgSize);

function colorizeSize(kb: number) {
    if (Number.isNaN(kb)) return '';

    let colorFunc: (str: string) => string;
    if (kb > 1000) {
        colorFunc = c.red;
    } else if (kb > 100) {
        colorFunc = c.yellow;
    } else {
        colorFunc = c.green;
    }
    return `(${colorFunc(`${kb}kb`)})`;
}

export default createUnplugin<Options | undefined>(() => {
    const name = 'unplugin-detect-duplicated-deps';
    let isVitePlugin = false;

    /**
     * Map(1) {
     *   'axios' => Map(2) {
     *     '1.4.0' => Set(2) { 'tests/fixtures/mono/packages/pkg1/index.js', 'axios' },
     *     '0.27.2' => Set(2) { 'tests/fixtures/mono/packages/pkg2/index.js', 'axios' }
     *   }
     * }
     */
    const packageToVersionsMap = new Map<string, Map<string, Set<string>>>();

    const resolveId: RollupPlugin['resolveId'] = async function (source, importer, options) {
        if (!importer || options.isEntry) return;

        const resolved = await this.resolve(source, importer, {
            ...options,
            skipSelf: true,
        });

        if (resolved) {
            const packageInfo = await getPackageInfo(resolved.id);
            if (packageInfo) {
                const { name, version } = packageInfo;
                const formattedImporter = await formatImporter(importer);
                const existedVersionsMap = packageToVersionsMap.get(name);
                if (existedVersionsMap) {
                    const existedImporters = existedVersionsMap.get(version);
                    if (existedImporters) {
                        existedImporters.add(formattedImporter);
                    } else {
                        existedVersionsMap.set(version, new Set([formattedImporter]));
                    }
                } else {
                    const versionMap = new Map<string, Set<string>>([
                        [version, new Set([formattedImporter])],
                    ]);
                    packageToVersionsMap.set(name, versionMap);
                }
            }
        }
    };

    const buildEnd: RollupPlugin['buildEnd'] = async function () {
        const duplicatedPackages: string[] = [];
        for (const [packageName, versionsMap] of packageToVersionsMap.entries()) {
            if (versionsMap.size > 1) {
                duplicatedPackages.push(packageName);
            }
        }
        if (duplicatedPackages.length === 0) return;

        const formattedDuplicatedPackageNames = duplicatedPackages
            .map((name) => c.magenta(name))
            .join(', ');
        const warningMessages = [
            `multiple versions of ${formattedDuplicatedPackageNames} is bundled!`,
        ];

        const promises = duplicatedPackages.map(async (duplicatedPackage) => {
            const sortedVersions = [...packageToVersionsMap.get(duplicatedPackage)!.keys()].sort(
                (a, b) => (gt(a, b) ? 1 : -1),
            );

            let longestVersionLength = Number.NEGATIVE_INFINITY;
            sortedVersions.forEach((v) => {
                if (v.length > longestVersionLength) {
                    longestVersionLength = v.length;
                }
            });

            let totalSize = 0;
            const _promises = sortedVersions.map(async (version) => {
                const importers = Array.from(
                    packageToVersionsMap.get(duplicatedPackage)!.get(version)!,
                );
                const formattedVersion = c.bold(
                    c.yellow(version.padEnd(longestVersionLength, ' ')),
                );
                const formattedImporters = importers
                    .filter((importer) => importer !== `${duplicatedPackage}@${version}`)
                    .map((name) => c.green(name))
                    .join(', ');
                const pkgSize = await getPkgSize(duplicatedPackage, version);
                totalSize += pkgSize;
                warningMessages.push(
                    // prettier-ignore
                    `    - ${formattedVersion}${colorizeSize(pkgSize)} imported by ${formattedImporters}`,
                );
            });
            await Promise.all(_promises);

            warningMessages.splice(
                warningMessages.length - sortedVersions.length,
                0,
                `\n  ${c.magenta(duplicatedPackage)}${colorizeSize(totalSize)}:`,
            );
        });
        await Promise.all(promises);

        // remove vite output dim colorize
        // eslint-disable-next-line unicorn/escape-case, unicorn/no-hex-escape
        process.stdout.write(`\x1b[0m${isVitePlugin ? '\n' : ''}`);
        consola.warn(warningMessages.join('\n'));

        // recycle cached promise
        getWorkspaceRootFolder.destroy();
        getPackageInfo.destroy();
        formatImporter.destroy();
        getPkgSize.destroy();
    };

    return {
        name,
        vite: {
            enforce: 'pre',
            config() {
                isVitePlugin = true;
            },
            resolveId,
            buildEnd,
        },
        rollup: {
            resolveId,
            buildEnd,
        },
    };
});

import IntervalTree from '@flatten-js/interval-tree';
import { App, CachedMetadata, getLinkpath, TFile } from 'obsidian';

import { LinkerPluginSettings } from 'main';
import { LinkerCache, PrefixTree } from './linkerCache';
import { VirtualMatch } from './virtualLinkDom';

type LinkCountByTarget = Record<string, number>;
type LinkCountBySource = Record<string, LinkCountByTarget>;

interface LocLike {
    line: number;
    col: number;
    offset: number;
}

interface PosLike {
    start: LocLike;
    end: LocLike;
}

interface VirtualLinkCacheRef {
    link: string;
    original: string;
    displayText?: string;
    position: PosLike;
    __glossaryVirtual?: boolean;
    __glossaryVirtualKey?: string;
}

interface ComputedVirtualMetadata {
    linkCounts: LinkCountBySource;
    refsBySource: Record<string, VirtualLinkCacheRef[]>;
    backlinksByTarget: Record<string, Record<string, VirtualLinkCacheRef[]>>;
    totalMatches: number;
}

const REFRESH_INTERVAL_MIN_MS = 500;
const REFRESH_INTERVAL_MAX_MS = 60_000;
const YIELD_EVERY_FILES = 25;

export class VirtualLinkMetadataBridge {
    private readonly linkerCache: LinkerCache;
    private appliedVirtualLinks: LinkCountBySource = {};
    private appliedVirtualRefsBySource: Record<string, VirtualLinkCacheRef[]> = {};
    private virtualBacklinksByTarget: Record<string, Record<string, VirtualLinkCacheRef[]>> = {};

    private refreshTimer: number | null = null;
    private refreshRunning = false;
    private refreshQueued = false;
    private disposed = false;
    private suppressResolvedEvent = false;
    private lastRefreshStartedAt = 0;

    private originalGetBacklinksForFile: ((file: any) => any) | null = null;
    private loggedBacklinksShape = false;
    private lastLogMessage = '';
    private lastLogAt = 0;

    constructor(
        private readonly app: App,
        private readonly settings: LinkerPluginSettings
    ) {
        this.linkerCache = LinkerCache.getInstance(app, settings);
        this.patchBacklinksApi();
    }

    scheduleRefresh(reason: string = 'unknown'): void {
        if (this.disposed) {
            return;
        }

        if (!this.settings.includeVirtualLinksInGraph && !this.settings.includeVirtualLinksInBacklinks) {
            this.log(`Skipping schedule (${reason}) because graph/backlinks integration is disabled`);
            return;
        }

        const intervalMs = this.getRefreshIntervalMs();
        const now = Date.now();
        const elapsedSinceLastStart = now - this.lastRefreshStartedAt;
        const delayMs = Math.max(intervalMs, intervalMs - elapsedSinceLastStart);

        if (this.refreshTimer !== null) {
            window.clearTimeout(this.refreshTimer);
        }

        this.refreshTimer = window.setTimeout(() => {
            this.refreshTimer = null;
            void this.refreshNow(`debounced:${reason}`);
        }, delayMs);

        this.log(`Scheduled refresh in ${delayMs}ms (${reason})`);
    }

    handleMetadataResolvedEvent(): void {
        if (this.disposed || this.suppressResolvedEvent) {
            return;
        }
        this.scheduleRefresh('metadata-resolved');
    }

    async refreshNow(reason: string = 'manual'): Promise<void> {
        if (this.disposed) {
            return;
        }

        if (this.refreshRunning) {
            this.refreshQueued = true;
            this.log(`Refresh already running, queueing next run (${reason})`);
            return;
        }

        const startedAt = performance.now();
        this.lastRefreshStartedAt = Date.now();
        this.refreshRunning = true;
        this.log(`Starting refresh (${reason})`);

        try {
            this.unapplyVirtualData();

            if (!this.settings.linkerActivated) {
                this.log('Linker disabled, only cleanup performed');
                this.triggerResolved();
                return;
            }

            if (!this.settings.includeVirtualLinksInGraph && !this.settings.includeVirtualLinksInBacklinks) {
                this.log('Graph/backlinks integration disabled, only cleanup performed');
                this.triggerResolved();
                return;
            }

            this.linkerCache.cache.updateTree();
            const computed = await this.computeVirtualLinks();

            this.virtualBacklinksByTarget = computed.backlinksByTarget;

            if (this.settings.includeVirtualLinksInGraph) {
                this.applyVirtualLinkCounts(computed.linkCounts);
            }

            if (this.settings.includeVirtualLinksInBacklinks) {
                this.applyVirtualCacheRefs(computed.refsBySource);
            }

            this.log(
                `Refresh complete in ${(performance.now() - startedAt).toFixed(1)}ms ` +
                `(sources with links: ${Object.keys(computed.linkCounts).length}, matches: ${computed.totalMatches})`
            );

            this.triggerResolved();
        } catch (error) {
            console.error('[Glossary][VirtualMetadata] Failed to refresh virtual metadata', error);
        } finally {
            this.refreshRunning = false;
            if (this.refreshQueued && !this.disposed) {
                this.refreshQueued = false;
                this.scheduleRefresh('queued');
            }
        }
    }

    destroy(): void {
        this.disposed = true;

        if (this.refreshTimer !== null) {
            window.clearTimeout(this.refreshTimer);
            this.refreshTimer = null;
        }

        this.unapplyVirtualData();
        this.restoreBacklinksApi();
        this.triggerResolved();
        this.log('Destroyed bridge and restored metadata/backlink state');
    }

    private patchBacklinksApi(): void {
        const metadataCacheAny = this.app.metadataCache as any;
        const original = metadataCacheAny?.getBacklinksForFile;

        if (typeof original !== 'function') {
            this.log('metadataCache.getBacklinksForFile is not available; backlinks patch skipped');
            return;
        }

        this.originalGetBacklinksForFile = original.bind(metadataCacheAny);

        metadataCacheAny.getBacklinksForFile = (file: any) => {
            const result = this.originalGetBacklinksForFile
                ? this.originalGetBacklinksForFile(file)
                : original.call(metadataCacheAny, file);
            return this.mergeVirtualBacklinksIntoResult(file, result);
        };

        this.log('Patched metadataCache.getBacklinksForFile for virtual link injection');
    }

    private restoreBacklinksApi(): void {
        if (!this.originalGetBacklinksForFile) {
            return;
        }

        const metadataCacheAny = this.app.metadataCache as any;
        metadataCacheAny.getBacklinksForFile = this.originalGetBacklinksForFile;
        this.originalGetBacklinksForFile = null;
        this.log('Restored original metadataCache.getBacklinksForFile');
    }

    private mergeVirtualBacklinksIntoResult(fileOrPath: TFile | string | null | undefined, originalResult: any): any {
        if (!this.settings.includeVirtualLinksInBacklinks) {
            return originalResult;
        }

        let targetPath = typeof fileOrPath === 'string' ? fileOrPath : fileOrPath?.path;
        if (typeof fileOrPath === 'string' && targetPath && !targetPath.endsWith('.md')) {
            const resolved = this.app.metadataCache.getFirstLinkpathDest(getLinkpath(fileOrPath), '');
            if (resolved?.path) {
                targetPath = resolved.path;
            }
        }
        if (!targetPath) {
            return originalResult;
        }

        const virtualBySource = this.virtualBacklinksByTarget[targetPath];
        if (!virtualBySource || Object.keys(virtualBySource).length === 0) {
            return originalResult;
        }

        let result = originalResult;
        if (!result || typeof result !== 'object') {
            result = { data: {}, count: 0 };
        }

        if (!this.loggedBacklinksShape) {
            this.loggedBacklinksShape = true;
            const data = (result as any).data;
            const dataShape = data instanceof Map ? 'Map' : typeof data;
            this.log(`Backlinks result shape for ${targetPath}: type=${typeof result}, data=${dataShape}`);
        }

        const dataContainer = (result as any).data;
        let added = 0;

        if (dataContainer instanceof Map) {
            for (const [sourcePath, refs] of Object.entries(virtualBySource)) {
                const existing = dataContainer.get(sourcePath);
                const merged = this.mergeBacklinkEntry(existing, refs);
                const mergedCount = this.countEntryItems(merged);
                const existingCount = this.countEntryItems(existing);
                added += Math.max(0, mergedCount - existingCount);
                dataContainer.set(sourcePath, merged);
            }
        } else {
            const objectData = (dataContainer && typeof dataContainer === 'object') ? dataContainer : {};
            (result as any).data = objectData;
            for (const [sourcePath, refs] of Object.entries(virtualBySource)) {
                const existing = objectData[sourcePath];
                const merged = this.mergeBacklinkEntry(existing, refs);
                const mergedCount = this.countEntryItems(merged);
                const existingCount = this.countEntryItems(existing);
                added += Math.max(0, mergedCount - existingCount);
                objectData[sourcePath] = merged;
            }
        }

        if (typeof (result as any).count === 'number' && added > 0) {
            (result as any).count += added;
        }

        if (added > 0) {
            this.log(`Injected ${added} virtual backlink refs for target ${targetPath}`);
        }

        return result;
    }

    private mergeBacklinkEntry(existing: any, refs: VirtualLinkCacheRef[]): any {
        if (existing == null) {
            return refs.map((ref) => ({ ...ref }));
        }

        if (Array.isArray(existing)) {
            const existingKeys = new Set<string>();
            for (const item of existing) {
                const key = item?.__glossaryVirtualKey;
                if (typeof key === 'string') {
                    existingKeys.add(key);
                }
            }

            for (const ref of refs) {
                const key = ref.__glossaryVirtualKey;
                if (!key || !existingKeys.has(key)) {
                    existing.push({ ...ref });
                    if (key) {
                        existingKeys.add(key);
                    }
                }
            }
            return existing;
        }

        if (existing && typeof existing === 'object' && Array.isArray(existing.links)) {
            const existingLinks = existing.links;
            const existingKeys = new Set<string>();
            for (const item of existingLinks) {
                const key = item?.__glossaryVirtualKey;
                if (typeof key === 'string') {
                    existingKeys.add(key);
                }
            }
            for (const ref of refs) {
                const key = ref.__glossaryVirtualKey;
                if (!key || !existingKeys.has(key)) {
                    existingLinks.push({ ...ref });
                    if (key) {
                        existingKeys.add(key);
                    }
                }
            }
            return existing;
        }

        return existing;
    }

    private countEntryItems(entry: any): number {
        if (Array.isArray(entry)) {
            return entry.length;
        }
        if (entry && typeof entry === 'object' && Array.isArray(entry.links)) {
            return entry.links.length;
        }
        return 0;
    }

    private triggerResolved(): void {
        this.suppressResolvedEvent = true;
        this.app.metadataCache.trigger('resolved');
        this.suppressResolvedEvent = false;
    }

    private async computeVirtualLinks(): Promise<ComputedVirtualMetadata> {
        const linkCounts: LinkCountBySource = {};
        const refsBySource: Record<string, VirtualLinkCacheRef[]> = {};
        const backlinksByTarget: Record<string, Record<string, VirtualLinkCacheRef[]>> = {};
        const files = this.app.vault.getMarkdownFiles();
        let totalMatches = 0;

        let processed = 0;
        for (const sourceFile of files) {
            if (this.disposed) {
                break;
            }

            if (this.shouldSkipSourceFile(sourceFile)) {
                continue;
            }

            const text = await this.app.vault.cachedRead(sourceFile);
            const fileCache = this.app.metadataCache.getFileCache(sourceFile);
            const matches = this.collectMatchesFromText(text, sourceFile, fileCache);

            if (matches.length > 0) {
                const lineOffsets = this.buildLineOffsets(text);
                for (const match of matches) {
                    totalMatches += 1;
                    for (const targetFile of match.files) {
                        const sourcePath = sourceFile.path;
                        const targetPath = targetFile.path;

                        const targetCounts = linkCounts[sourcePath] ?? (linkCounts[sourcePath] = {});
                        targetCounts[targetPath] = (targetCounts[targetPath] ?? 0) + 1;

                        const ref = this.createVirtualCacheRef(sourceFile, targetFile, match, lineOffsets);
                        (refsBySource[sourcePath] ??= []).push(ref);
                        ((backlinksByTarget[targetPath] ??= {})[sourcePath] ??= []).push(ref);
                    }
                }

            }

            processed += 1;
            if (processed % YIELD_EVERY_FILES === 0) {
                await this.yieldToUi();
            }
        }

        return {
            linkCounts,
            refsBySource,
            backlinksByTarget,
            totalMatches,
        };
    }

    private shouldSkipSourceFile(file: TFile): boolean {
        const excluded = this.settings.excludedDirectoriesForLinking;
        if (excluded.length === 0) {
            return false;
        }

        const folderPath = file.parent?.path ?? '';
        return excluded.some((rawDir) => {
            const dir = rawDir.trim().replace(/^\/+|\/+$/g, '');
            if (!dir) {
                return false;
            }
            return folderPath === dir || folderPath.startsWith(`${dir}/`);
        });
    }

    private collectMatchesFromText(text: string, sourceFile: TFile, fileCache: CachedMetadata | null): VirtualMatch[] {
        this.linkerCache.reset();
        let matches: VirtualMatch[] = [];
        let id = 0;

        const explicitlyLinkedFiles = this.getExplicitlyLinkedFiles(sourceFile, fileCache);
        const alreadyLinkedFiles = new Set<TFile>();
        const excludedIntervals = this.buildExcludedIntervalTree(text, fileCache);

        let i = 0;
        while (i <= text.length) {
            const codePoint = text.codePointAt(i);
            const char = i < text.length && codePoint !== undefined ? String.fromCodePoint(codePoint) : '\n';

            const isWordBoundary = PrefixTree.checkWordBoundary(char);
            if (this.settings.matchAnyPartsOfWords || this.settings.matchBeginningOfWords || isWordBoundary) {
                const currentNodes = this.linkerCache.cache.getCurrentMatchNodes(
                    i,
                    this.settings.excludeLinksToOwnNote ? sourceFile : null
                );

                for (const node of currentNodes) {
                    if (
                        !this.settings.matchAnyPartsOfWords &&
                        this.settings.matchBeginningOfWords &&
                        !node.startsAtWordBoundary &&
                        this.settings.matchEndOfWords &&
                        !isWordBoundary
                    ) {
                        continue;
                    }

                    const nFrom = node.start;
                    const nTo = node.end;
                    if (nTo <= nFrom || nFrom < 0 || nTo > text.length) {
                        continue;
                    }

                    const originText = text.slice(nFrom, nTo);
                    const filteredFiles = this.linkerCache.cache.filterFilesByMatchBoundaries(
                        node.files,
                        node.startsAtWordBoundary,
                        isWordBoundary
                    );
                    if (filteredFiles.length === 0) {
                        continue;
                    }

                    const lowerFileBasenames = filteredFiles.map((file) => file.basename.toLowerCase());
                    const isAlias = !lowerFileBasenames.includes(originText.toLowerCase());

                    matches.push(
                        new VirtualMatch(
                            this.app,
                            id++,
                            originText,
                            nFrom,
                            nTo,
                            filteredFiles,
                            isAlias,
                            !isWordBoundary,
                            this.settings
                        )
                    );
                }
            }

            this.linkerCache.cache.pushChar(char);
            i += char.length;
        }

        matches = VirtualMatch.sort(matches);

        if (this.settings.excludeLinksToRealLinkedFiles) {
            matches = VirtualMatch.filterAlreadyLinked(matches, explicitlyLinkedFiles);
        }

        if (this.settings.onlyLinkOnce) {
            matches = VirtualMatch.filterAlreadyLinked(matches, alreadyLinkedFiles);
        }

        matches = VirtualMatch.filterOverlapping(matches, this.settings.onlyLinkOnce, excludedIntervals);

        if (this.settings.antialiasesEnabled) {
            matches = matches.filter((match) => {
                return !this.linkerCache.cache.isMatchExcludedByAntialias(text, match.from, match.to, match.files);
            });
        }

        matches = matches.filter((match) => match.files.length > 0);

        for (const match of matches) {
            for (const file of match.files) {
                alreadyLinkedFiles.add(file);
            }
        }

        return matches;
    }

    private getExplicitlyLinkedFiles(sourceFile: TFile, fileCache: CachedMetadata | null): Set<TFile> {
        const linkedFiles = new Set<TFile>();
        const refs = [...(fileCache?.links ?? []), ...(fileCache?.embeds ?? []), ...(fileCache?.frontmatterLinks ?? [])];

        for (const ref of refs) {
            const link = typeof ref.link === 'string' ? ref.link : '';
            if (!link) {
                continue;
            }

            const dest = this.app.metadataCache.getFirstLinkpathDest(getLinkpath(link), sourceFile.path);
            if (dest) {
                linkedFiles.add(dest);
            }
        }

        return linkedFiles;
    }

    private buildExcludedIntervalTree(text: string, fileCache: CachedMetadata | null): IntervalTree<unknown> {
        const excluded = new IntervalTree<unknown>();

        const addRegexIntervals = (regex: RegExp) => {
            let match: RegExpExecArray | null;
            regex.lastIndex = 0;
            while ((match = regex.exec(text)) !== null) {
                const start = match.index;
                const end = start + match[0].length;
                if (end > start) {
                    excluded.insert([start, end]);
                }
                if (match.index === regex.lastIndex) {
                    regex.lastIndex += 1;
                }
            }
        };

        addRegexIntervals(/```[\s\S]*?```|~~~[\s\S]*?~~~/g);
        addRegexIntervals(/`{1,3}[^`\n]+`{1,3}/g);
        addRegexIntervals(/\[\[[^\]]+\]\]/g);
        addRegexIntervals(/\[[^\]]+\]\([^)]+\)/g);
        addRegexIntervals(/https?:\/\/[^\s)\]]+/g);

        if (!this.settings.includeHeaders) {
            addRegexIntervals(/^[ \t]{0,3}#{1,6}[ \t].*$/gm);
        }

        const frontmatterPosition = fileCache?.frontmatterPosition;
        if (frontmatterPosition) {
            const lineOffsets = this.buildLineOffsets(text);
            const start = this.locToOffset(lineOffsets, frontmatterPosition.start.line, frontmatterPosition.start.col);
            const end = this.locToOffset(lineOffsets, frontmatterPosition.end.line, frontmatterPosition.end.col);
            if (end > start) {
                excluded.insert([start, end]);
            }
        }

        return excluded;
    }

    private buildLineOffsets(text: string): number[] {
        const offsets = [0];
        for (let i = 0; i < text.length; i++) {
            if (text[i] === '\n') {
                offsets.push(i + 1);
            }
        }
        return offsets;
    }

    private offsetToLoc(lineOffsets: number[], rawOffset: number): LocLike {
        const lastOffset = lineOffsets.length > 0 ? lineOffsets[lineOffsets.length - 1] : 0;
        const offset = Math.max(0, Math.min(rawOffset, lastOffset + 1_000_000));

        let low = 0;
        let high = lineOffsets.length - 1;
        let line = 0;

        while (low <= high) {
            const mid = Math.floor((low + high) / 2);
            const lineStart = lineOffsets[mid];
            const nextLineStart = mid + 1 < lineOffsets.length ? lineOffsets[mid + 1] : Number.MAX_SAFE_INTEGER;

            if (offset >= lineStart && offset < nextLineStart) {
                line = mid;
                break;
            }

            if (offset < lineStart) {
                high = mid - 1;
            } else {
                low = mid + 1;
            }
        }

        const lineStart = lineOffsets[line] ?? 0;
        return {
            line,
            col: Math.max(0, offset - lineStart),
            offset,
        };
    }

    private locToOffset(lineOffsets: number[], line: number, col: number): number {
        const lineOffset = lineOffsets[line] ?? lineOffsets[lineOffsets.length - 1] ?? 0;
        return Math.max(0, lineOffset + col);
    }

    private createVirtualCacheRef(
        sourceFile: TFile,
        targetFile: TFile,
        match: VirtualMatch,
        lineOffsets: number[]
    ): VirtualLinkCacheRef {
        const linkText = this.app.metadataCache.fileToLinktext(targetFile, sourceFile.path) || targetFile.path.replace(/\.md$/i, '');
        const original = linkText === match.originText
            ? `[[${linkText}]]`
            : `[[${linkText}|${match.originText}]]`;

        const start = this.offsetToLoc(lineOffsets, match.from);
        const end = this.offsetToLoc(lineOffsets, match.to);
        const key = `${sourceFile.path}=>${targetFile.path}@${match.from}-${match.to}:${match.originText}`;

        return {
            link: linkText,
            original,
            displayText: match.originText,
            position: { start, end },
            __glossaryVirtual: true,
            __glossaryVirtualKey: key,
        };
    }

    private applyVirtualLinkCounts(virtualLinks: LinkCountBySource): void {
        const resolvedLinks = this.app.metadataCache.resolvedLinks;
        let total = 0;

        for (const [sourcePath, targets] of Object.entries(virtualLinks)) {
            const sourceMap = resolvedLinks[sourcePath] ?? (resolvedLinks[sourcePath] = {});
            for (const [targetPath, count] of Object.entries(targets)) {
                sourceMap[targetPath] = (sourceMap[targetPath] ?? 0) + count;
                total += count;
            }
        }

        this.appliedVirtualLinks = virtualLinks;
        this.log(`Applied ${total} virtual link counts into metadataCache.resolvedLinks`);
    }

    private applyVirtualCacheRefs(refsBySource: Record<string, VirtualLinkCacheRef[]>): void {
        const applied: Record<string, VirtualLinkCacheRef[]> = {};
        let totalAdded = 0;

        for (const [sourcePath, refs] of Object.entries(refsBySource)) {
            const sourceFile = this.app.vault.getFileByPath(sourcePath);
            if (!sourceFile) {
                continue;
            }

            const fileCacheAny = this.app.metadataCache.getFileCache(sourceFile) as any;
            if (!fileCacheAny) {
                continue;
            }

            const existingLinks = Array.isArray(fileCacheAny.links) ? fileCacheAny.links : [];
            const existingKeys = new Set<string>();
            for (const item of existingLinks) {
                const key = item?.__glossaryVirtualKey;
                if (typeof key === 'string') {
                    existingKeys.add(key);
                }
            }

            const toAdd = refs.filter((ref) => {
                const key = ref.__glossaryVirtualKey;
                return !key || !existingKeys.has(key);
            });

            if (toAdd.length > 0) {
                fileCacheAny.links = [...existingLinks, ...toAdd.map((ref) => ({ ...ref }))];
                applied[sourcePath] = toAdd;
                totalAdded += toAdd.length;
            }
        }

        this.appliedVirtualRefsBySource = applied;
        this.log(`Applied ${totalAdded} synthetic link refs into file caches for backlinks`);
    }

    private unapplyVirtualData(): void {
        this.unapplyVirtualLinkCounts();
        this.unapplyVirtualCacheRefs();
        this.virtualBacklinksByTarget = {};
    }

    private unapplyVirtualLinkCounts(): void {
        const resolvedLinks = this.app.metadataCache.resolvedLinks;

        for (const [sourcePath, targets] of Object.entries(this.appliedVirtualLinks)) {
            const sourceMap = resolvedLinks[sourcePath];
            if (!sourceMap) {
                continue;
            }

            for (const [targetPath, count] of Object.entries(targets)) {
                const current = sourceMap[targetPath] ?? 0;
                const next = current - count;
                if (next > 0) {
                    sourceMap[targetPath] = next;
                } else {
                    delete sourceMap[targetPath];
                }
            }

            if (Object.keys(sourceMap).length === 0) {
                delete resolvedLinks[sourcePath];
            }
        }

        this.appliedVirtualLinks = {};
    }

    private unapplyVirtualCacheRefs(): void {
        for (const sourcePath of Object.keys(this.appliedVirtualRefsBySource)) {
            const sourceFile = this.app.vault.getFileByPath(sourcePath);
            if (!sourceFile) {
                continue;
            }

            const fileCacheAny = this.app.metadataCache.getFileCache(sourceFile) as any;
            if (!fileCacheAny || !Array.isArray(fileCacheAny.links)) {
                continue;
            }

            fileCacheAny.links = fileCacheAny.links.filter((link: any) => !link?.__glossaryVirtual);
        }

        this.appliedVirtualRefsBySource = {};
    }

    private async yieldToUi(): Promise<void> {
        await new Promise<void>((resolve) => {
            window.setTimeout(() => resolve(), 0);
        });
    }

    private getRefreshIntervalMs(): number {
        const raw = Number(this.settings.virtualLinkMetadataRefreshMs);
        if (!Number.isFinite(raw)) {
            return 6000;
        }
        return Math.round(Math.min(REFRESH_INTERVAL_MAX_MS, Math.max(REFRESH_INTERVAL_MIN_MS, raw)));
    }

    private log(message: string): void {
        if (!this.settings.debugLogging) {
            return;
        }
        const now = Date.now();
        if (message === this.lastLogMessage && now - this.lastLogAt < 1500) {
            return;
        }
        this.lastLogMessage = message;
        this.lastLogAt = now;
        console.log(`[Glossary][VirtualMetadata] ${message}`);
    }
}

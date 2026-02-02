import { App, ItemView, TFile, WorkspaceLeaf, setIcon, Menu, Notice, MarkdownRenderer, Component } from 'obsidian';
import { LinkerPluginSettings } from '../main';
import { LinkerMetaInfoFetcher } from './linkerInfo';

export const GLOSSARY_VIEW_TYPE = 'glossary-view';

type SortField = 'name' | 'modified';
type SortDirection = 'asc' | 'desc';
type ViewMode = 'list' | 'preview';

interface GlossaryEntry {
    file: TFile;
    name: string;
    aliases: string[];
    isExcluded: boolean;
}

interface GroupedEntries {
    [letter: string]: GlossaryEntry[];
}

// Shared cache across view instances for instant reopen
let sharedEntryCache: GlossaryEntry[] = [];
let sharedFilteredCache: GlossaryEntry[] = [];
let sharedCacheValid = false;
let sharedFilterState = { query: '', sortField: 'name' as SortField, sortDirection: 'asc' as SortDirection };

export class GlossaryView extends ItemView {
    private searchInput: HTMLInputElement;
    private entriesContainer: HTMLElement;
    private listContainer: HTMLElement | null = null;
    private entries: GlossaryEntry[] = [];
    private filteredEntries: GlossaryEntry[] = [];
    private sortField: SortField = 'name';
    private sortDirection: SortDirection = 'asc';
    private searchQuery: string = '';
    private isLoading: boolean = false;

    // View state
    private viewMode: ViewMode = 'list';
    private selectedEntry: GlossaryEntry | null = null;
    private navigationHistory: GlossaryEntry[] = [];
    private previewComponent: Component | null = null;
    private listScrollPosition: number = 0;

    // Virtual scrolling
    private renderedCount: number = 0;
    private readonly BATCH_SIZE = 50;
    private loadMoreObserver: IntersectionObserver | null = null;

    constructor(
        leaf: WorkspaceLeaf,
        private settings: LinkerPluginSettings,
        private updateCallback: () => void
    ) {
        super(leaf);
    }

    getViewType(): string {
        return GLOSSARY_VIEW_TYPE;
    }

    getDisplayText(): string {
        return 'Glossary';
    }

    getIcon(): string {
        return 'book-open';
    }

    async onOpen(): Promise<void> {
        const startTime = performance.now();

        const container = this.containerEl.children[1];
        container.empty();
        container.addClass('glossary-view-container');

        // Header with search and controls
        const header = container.createDiv({ cls: 'glossary-view-header' });

        // Search
        const searchContainer = header.createDiv({ cls: 'glossary-search-container' });
        this.searchInput = searchContainer.createEl('input', {
            type: 'text',
            placeholder: 'Search glossary...',
            cls: 'glossary-search-input'
        });
        this.searchInput.addEventListener('input', () => {
            this.searchQuery = this.searchInput.value;
            this.renderedCount = 0;
            this.listScrollPosition = 0;
            this.filterAndRenderEntries();
        });

        // Sort controls
        const sortContainer = searchContainer.createDiv({ cls: 'glossary-sort-container' });

        const sortFieldBtn = sortContainer.createDiv({ cls: 'glossary-sort-btn clickable-icon' });
        setIcon(sortFieldBtn, this.sortField === 'name' ? 'case-sensitive' : 'clock');
        sortFieldBtn.setAttribute('aria-label', 'Sort by');
        sortFieldBtn.addEventListener('click', (e) => this.showSortFieldMenu(e, sortFieldBtn));

        const sortDirBtn = sortContainer.createDiv({ cls: 'glossary-sort-btn clickable-icon' });
        setIcon(sortDirBtn, this.sortDirection === 'asc' ? 'arrow-up' : 'arrow-down');
        sortDirBtn.setAttribute('aria-label', this.sortDirection === 'asc' ? 'Ascending' : 'Descending');
        sortDirBtn.addEventListener('click', () => {
            this.sortDirection = this.sortDirection === 'asc' ? 'desc' : 'asc';
            setIcon(sortDirBtn, this.sortDirection === 'asc' ? 'arrow-up' : 'arrow-down');
            this.renderedCount = 0;
            this.listScrollPosition = 0;
            this.filterAndRenderEntries();
        });

        // Entries container
        this.entriesContainer = container.createDiv({ cls: 'glossary-entries-container' });

        // Register events
        this.registerEvent(this.app.vault.on('create', () => this.scheduleBackgroundRefresh()));
        this.registerEvent(this.app.vault.on('delete', () => this.scheduleBackgroundRefresh()));
        this.registerEvent(this.app.vault.on('rename', () => this.scheduleBackgroundRefresh()));
        this.registerEvent(this.app.metadataCache.on('changed', () => this.scheduleBackgroundRefresh()));

        console.log(`[Glossary] UI setup took ${(performance.now() - startTime).toFixed(1)}ms`);

        // Initial load
        if (sharedCacheValid && sharedEntryCache.length > 0) {
            console.log(`[Glossary] Using cached entries: ${sharedEntryCache.length}`);
            const cacheStart = performance.now();
            this.entries = sharedEntryCache;
            console.log(`[Glossary] Assigned entries in ${(performance.now() - cacheStart).toFixed(1)}ms`);
            this.filterAndRenderEntries();
            this.scheduleBackgroundRefresh();
        } else {
            // Load async without blocking
            this.loadEntriesAsync().then((entries) => {
                this.entries = entries;
                // Update shared cache
                sharedEntryCache = entries;
                sharedCacheValid = true;

                this.filterAndRenderEntries();
            });
        }
    }

    // Public API to open an entry in the glossay view
    openEntry(file: TFile): void {
        const entry = this.entries.find(e => e.file.path === file.path);
        if (entry) {
            this.navigateToEntry(entry);
        } else {
            console.warn('[Glossary] Entry not found for file:', file.path);
            // If not found in current entries (maybe not loaded yet?), we try to find it
            // This is a simple fallback
            new Notice('Glossary entry not found');
        }
    }

    async onClose(): Promise<void> {
        if (this.previewComponent) {
            this.previewComponent.unload();
        }
        if (this.loadMoreObserver) {
            this.loadMoreObserver.disconnect();
        }
    }

    private refreshTimeout: NodeJS.Timeout | null = null;

    private scheduleBackgroundRefresh(): void {
        if (this.refreshTimeout) clearTimeout(this.refreshTimeout);
        this.refreshTimeout = setTimeout(() => this.backgroundRefresh(), 1000);
    }

    private async backgroundRefresh(): Promise<void> {
        const newEntries = await this.loadEntriesAsync();
        // Only update if changed
        if (newEntries.length !== this.entries.length ||
            newEntries[0]?.file.path !== this.entries[0]?.file.path) {
            this.entries = newEntries;
            sharedEntryCache = newEntries;
            sharedCacheValid = true;
            this.filterAndRenderEntries();
        }
    }

    private async loadEntriesAsync(): Promise<GlossaryEntry[]> {
        const fetcher = new LinkerMetaInfoFetcher(this.app, this.settings);
        const allFiles = this.app.vault.getMarkdownFiles();
        const newEntries: GlossaryEntry[] = [];

        // Chunk processing to be non-blocking
        const CHUNK_SIZE = 200;
        for (let i = 0; i < allFiles.length; i += CHUNK_SIZE) {
            const chunk = allFiles.slice(i, i + CHUNK_SIZE);
            for (const file of chunk) {
                const metaInfo = fetcher.getMetaInfo(file);
                // Simplify inclusion logic for speed
                const isIncluded = metaInfo.includeAllFiles
                    ? (!metaInfo.excludeFile && !metaInfo.isInExcludedDir)
                    : (metaInfo.includeFile || metaInfo.isInIncludedDir);

                if (isIncluded || metaInfo.excludeFile) {
                    const cache = this.app.metadataCache.getFileCache(file);
                    const aliases = cache?.frontmatter?.aliases || [];
                    const normalizedAliases = Array.isArray(aliases) ? aliases : [aliases].filter(Boolean);

                    newEntries.push({
                        file,
                        name: file.basename,
                        aliases: normalizedAliases,
                        isExcluded: metaInfo.excludeFile
                    });
                }
            }
            // Yield
            if (i + CHUNK_SIZE < allFiles.length) {
                await new Promise(r => setTimeout(r, 0));
            }
        }
        return newEntries;
    }

    private showSortFieldMenu(e: MouseEvent, btn: HTMLElement): void {
        const menu = new Menu();
        menu.addItem(item => item.setTitle('Name').setIcon(this.sortField === 'name' ? 'check' : 'case-sensitive').onClick(() => {
            this.sortField = 'name';
            setIcon(btn, 'case-sensitive');
            this.renderedCount = 0;
            this.listScrollPosition = 0;
            this.filterAndRenderEntries();
        }));
        menu.addItem(item => item.setTitle('Modified').setIcon(this.sortField === 'modified' ? 'check' : 'clock').onClick(() => {
            this.sortField = 'modified';
            setIcon(btn, 'clock');
            this.renderedCount = 0;
            this.listScrollPosition = 0;
            this.filterAndRenderEntries();
        }));
        menu.showAtMouseEvent(e);
    }

    private filterAndRenderEntries(): void {
        const filterStart = performance.now();

        // Check if we can reuse cached filtered results
        const stateMatches =
            sharedFilterState.query === this.searchQuery &&
            sharedFilterState.sortField === this.sortField &&
            sharedFilterState.sortDirection === this.sortDirection &&
            sharedFilteredCache.length > 0 &&
            sharedEntryCache === this.entries;

        if (stateMatches) {
            // Reuse cached filtered/sorted results
            console.log(`[Glossary] Reusing cached filtered entries: ${sharedFilteredCache.length}`);
            this.filteredEntries = sharedFilteredCache;
        } else {
            console.log(`[Glossary] Re-filtering entries (state changed)`);
            // Filter
            if (this.searchQuery.trim()) {
                const query = this.searchQuery.toLowerCase();
                this.filteredEntries = this.entries.filter(entry =>
                    entry.name.toLowerCase().includes(query) ||
                    entry.aliases.some(alias => alias.toLowerCase().includes(query))
                );
            } else {
                this.filteredEntries = [...this.entries];
            }

            // Sort
            this.filteredEntries.sort((a, b) => {
                let cmp = 0;
                if (this.sortField === 'name') {
                    cmp = a.name.localeCompare(b.name);
                } else {
                    cmp = a.file.stat.mtime - b.file.stat.mtime;
                }
                return this.sortDirection === 'asc' ? cmp : -cmp;
            });

            // Update shared cache
            sharedFilteredCache = this.filteredEntries;
            sharedFilterState = {
                query: this.searchQuery,
                sortField: this.sortField,
                sortDirection: this.sortDirection
            };
        }

        console.log(`[Glossary] filterAndRenderEntries took ${(performance.now() - filterStart).toFixed(1)}ms (${this.filteredEntries.length} entries)`);

        // If currently in list view, re-render immediately to update list
        if (this.viewMode === 'list') {
            this.renderView();
        }
    }

    private renderView(): void {
        const renderStart = performance.now();
        this.entriesContainer.empty();
        if (this.previewComponent) {
            this.previewComponent.unload();
            this.previewComponent = null;
        }
        if (this.loadMoreObserver) {
            this.loadMoreObserver.disconnect();
            this.loadMoreObserver = null;
        }

        if (this.viewMode === 'list') {
            this.renderList();
        } else {
            this.renderPreview();
        }
        console.log(`[Glossary] renderView took ${(performance.now() - renderStart).toFixed(1)}ms`);
    }

    private renderList(): void {
        const listStart = performance.now();
        // Stats
        const statsEl = this.entriesContainer.createDiv({ cls: 'glossary-stats' });
        const activeCount = this.filteredEntries.filter(e => !e.isExcluded).length;
        const excludedCount = this.filteredEntries.filter(e => e.isExcluded).length;
        statsEl.textContent = `${activeCount} entries${excludedCount > 0 ? ` (${excludedCount} excluded)` : ''}`;

        if (this.filteredEntries.length === 0) {
            this.entriesContainer.createDiv({ cls: 'glossary-empty', text: this.searchQuery ? 'No matching entries' : 'No glossary entries' });
            return;
        }

        // Virtual scroll constants
        const ITEM_HEIGHT = 42; // Approximate height of each entry
        const BUFFER_ITEMS = 25; // Extra items to render above/below viewport
        const totalHeight = this.filteredEntries.length * ITEM_HEIGHT;

        // List Container with virtual scrolling
        this.listContainer = this.entriesContainer.createDiv({ cls: 'glossary-list-container' });
        const contentContainer = this.listContainer.createDiv({ cls: 'glossary-list-content' });
        contentContainer.style.height = `${totalHeight}px`;
        contentContainer.style.position = 'relative';

        // Track rendered range
        let renderedStart = 0;
        let renderedEnd = 0;
        let itemsContainer: HTMLElement | null = null;

        const renderVisibleItems = () => {
            const scrollTop = this.listContainer?.scrollTop || 0;
            const viewportHeight = this.listContainer?.clientHeight || 400;

            // Calculate visible range
            const startIdx = Math.max(0, Math.floor(scrollTop / ITEM_HEIGHT) - BUFFER_ITEMS);
            const endIdx = Math.min(
                this.filteredEntries.length,
                Math.ceil((scrollTop + viewportHeight) / ITEM_HEIGHT) + BUFFER_ITEMS
            );

            // Skip if range hasn't changed significantly
            if (itemsContainer && startIdx >= renderedStart && endIdx <= renderedEnd) {
                return;
            }

            console.log(`[Glossary] Virtual render ${startIdx}-${endIdx} (scroll: ${scrollTop.toFixed(0)})`);

            // Clear and re-render
            if (itemsContainer) {
                itemsContainer.remove();
            }
            itemsContainer = contentContainer.createDiv({ cls: 'glossary-virtual-items' });
            itemsContainer.style.position = 'absolute';
            itemsContainer.style.top = `${startIdx * ITEM_HEIGHT}px`;
            itemsContainer.style.left = '0';
            itemsContainer.style.right = '0';

            // Render visible entries (flat list for simplicity in virtual mode)
            const entriesToRender = this.filteredEntries.slice(startIdx, endIdx);

            // Group by letter if sorting by name
            if (this.sortField === 'name') {
                let currentLetter = '';
                for (let i = 0; i < entriesToRender.length; i++) {
                    const entry = entriesToRender[i];
                    const firstChar = entry.name.charAt(0).toUpperCase();
                    const letter = /[A-Z]/.test(firstChar) ? firstChar : '#';

                    if (letter !== currentLetter) {
                        // Add letter header
                        const headerEl = itemsContainer.createDiv({ cls: 'glossary-letter-header-inline' });
                        headerEl.textContent = letter;
                        currentLetter = letter;
                    }
                    this.renderEntry(entry, itemsContainer);
                }
            } else {
                for (const entry of entriesToRender) {
                    this.renderEntry(entry, itemsContainer);
                }
            }

            renderedStart = startIdx;
            renderedEnd = endIdx;
        };

        // Initial render
        renderVisibleItems();
        console.log(`[Glossary] renderList core took ${(performance.now() - listStart).toFixed(1)}ms`);

        // Restore scroll position
        if (this.listScrollPosition > 0) {
            this.listContainer.scrollTop = this.listScrollPosition;
            // Re-render after scroll position is set
            requestAnimationFrame(() => renderVisibleItems());
        }

        // Debounced scroll handler
        let scrollTimeout: NodeJS.Timeout | null = null;
        this.listContainer.addEventListener('scroll', () => {
            if (this.listContainer) {
                this.listScrollPosition = this.listContainer.scrollTop;
            }
            if (scrollTimeout) clearTimeout(scrollTimeout);
            scrollTimeout = setTimeout(renderVisibleItems, 16); // ~60fps
        });
    }

    private renderEntriesBatch(container: HTMLElement, startIdx: number, endIdx: number): void {
        const batchStart = performance.now();
        // Basic batch rendering without complex virtual diffing for simplicity and robustness
        // We just append new items

        // However, if we are sorting by name, we need to handle letter groups carefully.
        // It's easier to just re-render specifically the NEW items, finding correct groups.

        const entriesToRender = this.filteredEntries.slice(startIdx, endIdx);

        if (this.sortField === 'name') {
            const grouped = this.groupByLetter(entriesToRender);
            const letters = Object.keys(grouped).sort((a, b) =>
                this.sortDirection === 'asc' ? a.localeCompare(b) : b.localeCompare(a)
            );

            for (const letter of letters) {
                // Find or create group
                let groupEl = container.querySelector(`.glossary-letter-group[data-letter="${letter}"]`) as HTMLElement;
                if (!groupEl) {
                    groupEl = container.createDiv({ cls: 'glossary-letter-group' });
                    groupEl.setAttribute('data-letter', letter);

                    const headerEl = groupEl.createDiv({ cls: 'glossary-letter-header' });
                    headerEl.textContent = letter;

                    groupEl.createDiv({ cls: 'glossary-letter-separator' });
                    groupEl.createDiv({ cls: 'glossary-letter-entries' }); // container for items
                }

                const entriesContainer = groupEl.querySelector('.glossary-letter-entries') as HTMLElement;
                for (const entry of grouped[letter]) {
                    this.renderEntry(entry, entriesContainer);
                }
            }
        } else {
            // Flat list
            for (const entry of entriesToRender) {
                this.renderEntry(entry, container);
            }
        }
        console.log(`[Glossary] renderEntriesBatch(${startIdx}-${endIdx}) took ${(performance.now() - batchStart).toFixed(1)}ms`);
    }

    private groupByLetter(entries: GlossaryEntry[]): GroupedEntries {
        const grouped: GroupedEntries = {};
        for (const entry of entries) {
            const firstChar = entry.name.charAt(0).toUpperCase();
            const letter = /[A-Z]/.test(firstChar) ? firstChar : '#';
            if (!grouped[letter]) grouped[letter] = [];
            grouped[letter].push(entry);
        }
        return grouped;
    }

    private renderEntry(entry: GlossaryEntry, container: HTMLElement): void {
        const entryEl = container.createDiv({
            cls: `glossary-entry-item${entry.isExcluded ? ' is-excluded' : ''}`
        });

        const contentEl = entryEl.createDiv({ cls: 'glossary-entry-content' });
        const textEl = contentEl.createDiv({ cls: 'glossary-entry-text' });

        textEl.createDiv({ cls: 'glossary-entry-name', text: entry.name });

        if (entry.aliases.length > 0) {
            const a = entry.aliases;
            const aliasText = a.length > 3 ? `${a.slice(0, 3).join(', ')} +${a.length - 3}` : a.join(', ');
            textEl.createDiv({ cls: 'glossary-entry-aliases', text: aliasText });
        }

        contentEl.addEventListener('click', () => {
            this.navigateToEntry(entry);
        });

        entryEl.addEventListener('contextmenu', (e) => this.showEntryContextMenu(e, entry));

        const actionsEl = entryEl.createDiv({ cls: 'glossary-entry-actions' });

        const openBtn = actionsEl.createDiv({ cls: 'glossary-action-btn clickable-icon' });
        setIcon(openBtn, 'external-link');
        openBtn.setAttribute('aria-label', 'Open file');
        openBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.app.workspace.getLeaf(false).openFile(entry.file);
        });

        const toggleBtn = actionsEl.createDiv({ cls: 'glossary-action-btn clickable-icon' });
        setIcon(toggleBtn, entry.isExcluded ? 'plus' : 'minus');
        toggleBtn.setAttribute('aria-label', entry.isExcluded ? 'Include' : 'Exclude');
        toggleBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            await this.toggleEntryExclusion(entry);
        });
    }

    private navigateToEntry(entry: GlossaryEntry) {
        if (this.selectedEntry) {
            this.navigationHistory.push(this.selectedEntry);
        }
        this.selectedEntry = entry;
        this.viewMode = 'preview';
        this.renderView();
    }

    private renderPreview(): void {
        if (!this.selectedEntry) {
            this.viewMode = 'list';
            this.renderList();
            return;
        }
        const entry = this.selectedEntry;

        // Header
        const headerEl = this.entriesContainer.createDiv({ cls: 'glossary-detail-header' });

        const backBtn = headerEl.createDiv({ cls: 'glossary-back-btn clickable-icon' });
        setIcon(backBtn, 'arrow-left');
        backBtn.addEventListener('click', () => {
            if (this.navigationHistory.length > 0) {
                this.selectedEntry = this.navigationHistory.pop()!;
                this.renderView();
            } else {
                this.selectedEntry = null;
                this.viewMode = 'list';
                this.renderView();
            }
        });

        const titleEl = headerEl.createDiv({ cls: 'glossary-detail-title' });
        titleEl.textContent = entry.name;

        const actionsEl = headerEl.createDiv({ cls: 'glossary-detail-actions' });
        const openBtn = actionsEl.createDiv({ cls: 'glossary-action-btn clickable-icon' });
        setIcon(openBtn, 'external-link');
        openBtn.addEventListener('click', () => this.app.workspace.getLeaf(false).openFile(entry.file));

        // Content
        const previewEl = this.entriesContainer.createDiv({ cls: 'glossary-preview-content markdown-rendered' });
        this.previewComponent = new Component();
        this.previewComponent.load();

        this.app.vault.cachedRead(entry.file).then(content => {
            MarkdownRenderer.render(
                this.app,
                content,
                previewEl,
                entry.file.path,
                this.previewComponent!
            );

            // Post-process links
            previewEl.querySelectorAll('a.internal-link').forEach((link: HTMLElement) => {
                link.addEventListener('click', (e) => {
                    const href = link.getAttribute('href');
                    if (href) {
                        const dest = this.app.metadataCache.getFirstLinkpathDest(href, entry.file.path);
                        if (dest instanceof TFile) {
                            const glossaryEntry = this.entries.find(ge => ge.file.path === dest.path);
                            if (glossaryEntry) {
                                e.preventDefault();
                                e.stopPropagation();
                                this.navigateToEntry(glossaryEntry);
                            }
                        }
                    }
                });

                link.addEventListener('mouseover', (e) => {
                    this.app.workspace.trigger('hover-link', {
                        event: e,
                        source: 'preview',
                        hoverParent: previewEl,
                        targetEl: link,
                        linktext: link.getAttribute('href'),
                        sourcePath: entry.file.path
                    });
                });
            });
        });
    }

    private showEntryContextMenu(e: MouseEvent, entry: GlossaryEntry): void {
        const menu = new Menu();
        menu.addItem(i => i.setTitle('Preview').setIcon('eye').onClick(() => this.navigateToEntry(entry)));
        menu.addItem(i => i.setTitle('Open file').setIcon('external-link').onClick(() => this.app.workspace.getLeaf(false).openFile(entry.file)));
        menu.addItem(i => i.setTitle('Open in new tab').setIcon('file-plus').onClick(() => this.app.workspace.getLeaf('tab').openFile(entry.file)));
        menu.addSeparator();
        menu.addItem(i => i.setTitle(entry.isExcluded ? 'Include' : 'Exclude').setIcon(entry.isExcluded ? 'plus' : 'trash').onClick(() => this.toggleEntryExclusion(entry)));
        menu.addSeparator();
        menu.addItem(i => i.setTitle('Reveal in explorer').setIcon('folder').onClick(() => {
            const fe = this.app.workspace.getLeavesOfType('file-explorer')[0];
            // @ts-ignore
            if (fe) fe.view.revealInFolder(entry.file);
        }));
        menu.showAtMouseEvent(e);
    }

    private async toggleEntryExclusion(entry: GlossaryEntry): Promise<void> {
        // Tag toggling logic...
        const tag = entry.isExcluded ? this.settings.tagToIncludeFile : this.settings.tagToExcludeFile;
        const removeTag = entry.isExcluded ? this.settings.tagToExcludeFile : this.settings.tagToIncludeFile;

        await this.app.fileManager.processFrontMatter(entry.file, fm => {
            if (!fm.tags) fm.tags = [];
            const tags = Array.isArray(fm.tags) ? fm.tags : [fm.tags];
            const set = new Set(tags);
            set.add(tag);
            set.delete(removeTag);
            fm.tags = [...set];
        });

        entry.isExcluded = !entry.isExcluded;
        this.updateCallback();
        new Notice(entry.isExcluded ? 'Excluded' : 'Included');
        // Debounce list refresh
        this.scheduleBackgroundRefresh();
    }
}

import { App, EditorPosition, getLinkpath, MarkdownView, Menu, Modal, Notice, Plugin, PluginSettingTab, Setting, TAbstractFile, TFile, TFolder, WorkspaceLeaf } from 'obsidian';

import { GlossaryLinker } from './linker/readModeLinker';
import { liveLinkerPlugin } from './linker/liveLinker';
import { ExternalUpdateManager, LinkerCache, PrefixTree } from 'linker/linkerCache';
import { LinkerMetaInfoFetcher } from 'linker/linkerInfo';
import { GlossaryView, GLOSSARY_VIEW_TYPE } from './linker/GlossaryView';
import { AIEntryCreator } from './linker/aiEntryCreator';
import { VirtualLinkMetadataBridge } from './linker/virtualLinkMetadata';

import * as path from 'path';

export interface LinkerPluginSettings {
    advancedSettings: boolean;
    linkerActivated: boolean;
    suppressSuffixForSubWords: boolean;
    matchAnyPartsOfWords: boolean;
    matchEndOfWords: boolean;
    matchBeginningOfWords: boolean;
    includeAllFiles: boolean;
    linkerDirectories: string[];
    excludedDirectories: string[];
    excludedDirectoriesForLinking: string[];
    virtualLinkSuffix: string;
    virtualLinkAliasSuffix: string;
    useDefaultLinkStyleForConversion: boolean;
    defaultUseMarkdownLinks: boolean; // Otherwise wiki links
    defaultLinkFormat: 'shortest' | 'relative' | 'absolute';
    useMarkdownLinks: boolean;
    linkFormat: 'shortest' | 'relative' | 'absolute';
    applyDefaultLinkStyling: boolean;
    includeHeaders: boolean;
    matchCaseSensitive: boolean;
    capitalLetterProportionForAutomaticMatchCase: number;
    tagToIgnoreCase: string;
    tagToMatchCase: string;
    propertyNameToMatchCase: string;
    propertyNameToIgnoreCase: string;
    propertyNameAntialiases: string;
    propertyNameExactMatchOnly: string;
    exactMatchPropertyBackfillDone: boolean;
    antialiasPropertyBackfillDone: boolean;
    tagToExcludeFile: string;
    tagToIncludeFile: string;
    excludeLinksToOwnNote: boolean;
    fixIMEProblem: boolean;
    excludeLinksInCurrentLine: boolean;
    onlyLinkOnce: boolean;
    excludeLinksToRealLinkedFiles: boolean;
    includeAliases: boolean;
    alwaysShowMultipleReferences: boolean;
    hideFrontmatterInHoverPreview: boolean;
    antialiasesEnabled: boolean;
    openGlossaryLinksInSidebar: boolean;
    includeVirtualLinksInGraph: boolean;
    includeVirtualLinksInBacklinks: boolean;
    virtualLinkMetadataRefreshMs: number;
    enableSidebarSwipeGesture: boolean;
    debugLogging: boolean;
    // AI settings for glossary entry creation
    aiEnabled: boolean;
    aiActiveProvider: string;
    aiProviders: AIProviderConfig[];
    aiSystemPrompt: string;
    aiMaxTokens: number;
    // Metadata generation settings
    aiGenerateMetadata: boolean;
    aiMetadataModel: string;
    aiMetadataSystemPrompt: string;
    // Prompt variables
    aiAllowedLanguages: string;
    aiFallbackLanguage: string;
    // wordBoundaryRegex: string;
    // conversionFormat
}

export interface AIProviderConfig {
    id: string;
    name: string;
    endpoint: string;
    apiKey: string;
    model: string;
    modelsEndpoint?: string; // For fetching available models
}

// Default provider presets
export const AI_PROVIDER_PRESETS: Omit<AIProviderConfig, 'apiKey'>[] = [
    {
        id: 'openai',
        name: 'OpenAI',
        endpoint: 'https://api.openai.com/v1/chat/completions',
        model: 'gpt-4o-mini',
        modelsEndpoint: 'https://api.openai.com/v1/models',
    },
    {
        id: 'anthropic',
        name: 'Anthropic',
        endpoint: 'https://api.anthropic.com/v1/messages',
        model: 'claude-3-haiku-20240307',
    },
    {
        id: 'google',
        name: 'Google Gemini',
        endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
        model: 'gemini-2.0-flash',
        modelsEndpoint: 'https://generativelanguage.googleapis.com/v1beta/openai/models',
    },
    {
        id: 'openrouter',
        name: 'OpenRouter',
        endpoint: 'https://openrouter.ai/api/v1/chat/completions',
        model: 'openai/gpt-4o-mini',
        modelsEndpoint: 'https://openrouter.ai/api/v1/models',
    },
    {
        id: 'ollama',
        name: 'Ollama (Local)',
        endpoint: 'http://localhost:11434/v1/chat/completions',
        model: 'llama3.2',
        modelsEndpoint: 'http://localhost:11434/v1/models',
    },
    {
        id: 'custom',
        name: 'Custom',
        endpoint: '',
        model: '',
    },
];

type ExternalMathLinksApi = {
    version?: string;
    registerSourceRewriter?: (id: string, rewriter: (source: string, context: { sourcePath: string; renderer: string; displayMode?: boolean }) => string) => void;
    unregisterSourceRewriter?: (id: string) => void;
    createPlaceholder?: (target: string, prefix?: string) => string;
    registerPlaceholder?: (id: string, target: string, url?: string) => void;
    bindLinks?: (root: HTMLElement | Document) => void;
    processContainer?: (root: HTMLElement, sourcePath?: string) => void;
};

declare global {
    interface Window {
        MathLinksAPI?: ExternalMathLinksApi;
    }
}

const DEFAULT_SETTINGS: LinkerPluginSettings = {
    advancedSettings: false,
    linkerActivated: true,
    matchAnyPartsOfWords: false,
    matchEndOfWords: true,
    matchBeginningOfWords: true,
    suppressSuffixForSubWords: false,
    includeAllFiles: true,
    linkerDirectories: ['Glossary'],
    excludedDirectories: [],
    excludedDirectoriesForLinking: [],
    virtualLinkSuffix: '🔗',
    virtualLinkAliasSuffix: '🔗',
    useMarkdownLinks: false,
    linkFormat: 'shortest',
    defaultUseMarkdownLinks: false,
    defaultLinkFormat: 'shortest',
    useDefaultLinkStyleForConversion: true,
    applyDefaultLinkStyling: true,
    includeHeaders: true,
    matchCaseSensitive: false,
    capitalLetterProportionForAutomaticMatchCase: 0.75,
    tagToIgnoreCase: 'linker-ignore-case',
    tagToMatchCase: 'linker-match-case',
    propertyNameToMatchCase: 'linker-match-case',
    propertyNameToIgnoreCase: 'linker-ignore-case',
    propertyNameAntialiases: 'antialiases',
    propertyNameExactMatchOnly: 'linker-exact-match-only',
    exactMatchPropertyBackfillDone: false,
    antialiasPropertyBackfillDone: false,
    tagToExcludeFile: 'linker-exclude',
    tagToIncludeFile: 'linker-include',
    excludeLinksToOwnNote: true,
    fixIMEProblem: false,
    excludeLinksInCurrentLine: false,
    onlyLinkOnce: true,
    excludeLinksToRealLinkedFiles: true,
    includeAliases: true,
    alwaysShowMultipleReferences: false,
    hideFrontmatterInHoverPreview: true,
    antialiasesEnabled: true,
    openGlossaryLinksInSidebar: false,
    includeVirtualLinksInGraph: true,
    includeVirtualLinksInBacklinks: true,
    virtualLinkMetadataRefreshMs: 6000,
    enableSidebarSwipeGesture: true,
    debugLogging: true,
    // AI settings
    aiEnabled: false,
    aiActiveProvider: 'openai',
    aiProviders: [],
    aiSystemPrompt: `# Glossary Definition Generator

Generate ONLY the definition content. Do NOT include frontmatter or YAML blocks.

## Term Normalization
* Use the **lemma** (dictionary) form of the term (singular, base form)
* **Capitalize** the first letter unless the term is conventionally lowercase (e.g., pH, mRNA)
* Keep scientific/technical notation intact

## Output Format
# <Term>

<Definition paragraph>

<Optional bullet points for additional details>

## Frontmatter Compatibility
* If another instruction requests YAML frontmatter, include \`linker-exact-match-only: false\` by default.
* Include \`antialiases: []\` in YAML frontmatter by default.

## Language Logic
* **Variables:** \`<Allowed_Languages>\` = [{{ALLOWED_LANGUAGES}}], \`<Fallback_Language>\` = {{FALLBACK_LANGUAGE}}
* **Action:** Detect language of \`<Term>\`.
* **Condition:**
    * **IF** detected language is in \`<Allowed_Languages>\`: Output in detected language.
    * **ELSE**: Output strictly in \`<Fallback_Language>\`.
* **Constraint:** No mixed languages unless technical necessity.

## Critical Style (Brevity & Density)
* **Tone:** Clinical, directive, efficient.
* **Sentence Structure:** Active voice. Minimal length.
* **Lists:** **TELEGRAPHIC ONLY**. Noun phrases or fragments. **NO** full sentences.
* **Redundancy:** **FORBIDDEN**. State facts once. Never summarize previous points.
* **Explanation:** Zero fluff. No "This means that..." or "In other words...".
* **Audience:** Novice. Simple terms. Zero assumptions.

## Layout Logic
* **Structure:** Definition first. Then Bullet points.
* **Tables:** **Use only** for direct A/B comparisons. Else: Lists.
* **Header:** NO "Definition:" prefix. Start immediately.

## Math & Rendering (KaTeX)
* **Syntax:** \`$...$\` (inline), \`$$...$$\` (block).
* **Prohibition:** **NEVER** output raw \`$\`. **NEVER** escape \`$\`.
* **Isolation:** No Markdown (\`**\`, \`_\`) around Math blocks.
* **Color:** Use \`\\textcolor{color}{text}\` inside math (darkorange, cornflowerblue, teal, mediumorchid).

## Pre-Flight Checklist
1.  Is output language valid per \`<Allowed_Languages>\` logic?
2.  Are all fillers removed?
3.  Are lists fragments (not sentences)?
4.  Is redundancy = 0?
5.  Are \`$\` signs invisible (rendered)?`,
    aiMaxTokens: 4000,
    aiGenerateMetadata: false,
    aiMetadataModel: '',
    aiMetadataSystemPrompt: `Generate metadata for a glossary entry as a JSON object.

Required fields:
- title: Lemma form (singular, capitalized unless conventionally lowercase like pH, mRNA)
- aliases: 2-5 common alternatives, plurals, synonyms, abbreviations (array of strings)
- tags: Always include "glossary" plus 1-2 relevant topic tags (array of strings)
- antialiases: Array of strings, default [] when no anti-aliases are needed.
- exactMatchOnly: Boolean, default false. Set true only when strict exact title/alias matching is explicitly required.

Language: Match the input term's language if in [{{ALLOWED_LANGUAGES}}], else use {{FALLBACK_LANGUAGE}}.

Return ONLY valid JSON. No markdown code blocks. No explanation. Example:
{"title": "Term", "aliases": ["alt1", "alt2"], "tags": ["glossary", "topic"], "antialiases": [], "exactMatchOnly": false}`,
    aiAllowedLanguages: 'English, German',
    aiFallbackLanguage: 'English',

    // wordBoundaryRegex: '/[\\t- !-/:-@\\[-`{-~\\p{Emoji_Presentation}\\p{Extended_Pictographic}]/u',
};

export default class LinkerPlugin extends Plugin {
    settings: LinkerPluginSettings;
    updateManager = new ExternalUpdateManager();
    private virtualLinkMetadata: VirtualLinkMetadataBridge | null = null;
    private sidebarSwipeState: 'idle' | 'dragging' = 'idle';
    private sidebarSwipeProgress = 0; // 0 = collapsed, 1 = expanded
    private sidebarSwipeWasCollapsed = false;
    private sidebarSwipeEndTimeout: ReturnType<typeof setTimeout> | null = null;
    private lastSidebarSwipeEventAt = 0;
    private exactMatchBackfillTimer: number | null = null;
    private exactMatchBackfillRunning = false;
    private lastMathDiagnosticsAtBySource = new Map<string, number>();
    private readonly glossaryMathPlaceholderPrefix = 'GlossaryMathID_';
    private readonly glossaryMathLinkTargets = new Map<string, { linkText: string; url: string; createdAt: number }>();
    private readonly mathLinksGlossaryRewriterId = 'glossary:virtual-linker';
    private didAttachMathLinksApiRewriter = false;
    private didLogMathLinksApiUnavailable = false;
    private didLogKatexRendererUnavailable = false;
    private didLogMathJaxRendererUnavailable = false;

    async onload() {
        await this.loadSettings();
        this.virtualLinkMetadata = new VirtualLinkMetadataBridge(this.app, this.settings);
        this.logDebug('Plugin loading with settings', this.settings);
        // Try early patching before layout-ready in case KaTeX/MathLinksAPI are already available
        this.tryAttachMathLinksApiRewriter('early-onload');
        if (!this.didAttachMathLinksApiRewriter) {
            this.ensureKatexRendererPatched('early-onload');
            this.ensureMathJaxRenderersPatched('early-onload');
        }
        this.setupMathLinksApiIntegration();
        this.patchMathRenderers();
        this.app.workspace.onLayoutReady(() => {
            const detected = this.logMathLinkerStatus();
            if (!detected) {
                window.setTimeout(() => this.logMathLinkerStatus(), 1800);
            }
            void this.backfillExactMatchPropertyIfNeeded();
        });

        // Apply body class for conditional CSS (hide frontmatter in hover preview)
        this.updateFrontmatterHidingClass();
        this.registerDomEvent(document, 'wheel', (event) => this.handleGlobalSidebarSwipe(event), { passive: false, capture: true });

        // Set callback to update the cache when the settings are changed
        this.updateManager.registerCallback(() => {
            LinkerCache.getInstance(this.app, this.settings).clearCache();
            this.updateFrontmatterHidingClass();
            this.virtualLinkMetadata?.scheduleRefresh('update-manager');
        });

        // Register the glossary sidebar view
        this.registerView(
            GLOSSARY_VIEW_TYPE,
            (leaf) => new GlossaryView(leaf, this.settings, () => this.updateManager.update())
        );

        // Add ribbon icon to open glossary
        this.addRibbonIcon('book-open', 'Open Glossary', () => {
            this.activateGlossaryView();
        });

        // Register glossary metadata properties as known property types
        // @ts-ignore - metadataTypeManager is internal API
        if (this.app.metadataTypeManager) {
            // @ts-ignore
            this.app.metadataTypeManager.setType(this.settings.propertyNameAntialiases, 'multitext');
            // @ts-ignore
            this.app.metadataTypeManager.setType(this.settings.propertyNameExactMatchOnly, 'checkbox');
            // Register a property info for rendering
            // @ts-ignore
            if (this.app.metadataTypeManager.properties) {
                // @ts-ignore
                this.app.metadataTypeManager.properties[this.settings.propertyNameAntialiases] = {
                    name: this.settings.propertyNameAntialiases,
                    type: 'multitext'
                };
                // @ts-ignore
                this.app.metadataTypeManager.properties[this.settings.propertyNameExactMatchOnly] = {
                    name: this.settings.propertyNameExactMatchOnly,
                    type: 'checkbox'
                };
            }
        }

        // Register the glossary linker for the read mode
        this.registerMarkdownPostProcessor((element, context) => {
            context.addChild(new GlossaryLinker(this.app, this.settings, context, element));
            this.tryAttachMathLinksApiRewriter(`postprocess:${context.sourcePath}`);
            const mathLinksApi = this.getMathLinksApi();
            const usingMathLinksApi =
                this.didAttachMathLinksApiRewriter &&
                (typeof mathLinksApi?.processContainer === 'function' || typeof mathLinksApi?.bindLinks === 'function');

            const runMathLinksApiProcess = () => {
                if (!usingMathLinksApi || !mathLinksApi) {
                    return;
                }
                if (typeof mathLinksApi.processContainer === 'function') {
                    mathLinksApi.processContainer(element, context.sourcePath);
                } else {
                    mathLinksApi.bindLinks?.(element);
                }
            };

            if (!usingMathLinksApi) {
                this.enhanceMathContent(element, context.sourcePath);
            } else {
                runMathLinksApiProcess();
            }
            this.bindMathLinkAnchors(element, context.sourcePath);
            window.setTimeout(() => {
                if (!usingMathLinksApi) {
                    this.enhanceMathContent(element, context.sourcePath);
                }
                this.bindMathLinkAnchors(element, context.sourcePath);
                runMathLinksApiProcess();
            }, 0);
            window.setTimeout(() => {
                this.bindMathLinkAnchors(element, context.sourcePath);
                runMathLinksApiProcess();
            }, 180);
            window.setTimeout(() => {
                this.bindMathLinkAnchors(element, context.sourcePath);
                runMathLinksApiProcess();
            }, 420);
            if (this.settings.debugLogging) {
                window.setTimeout(() => {
                    const mathBlocks = element.querySelectorAll('.math, .math-block, .katex, mjx-container, .MathJax').length;
                    if (mathBlocks === 0) {
                        return;
                    }
                    const now = Date.now();
                    const lastAt = this.lastMathDiagnosticsAtBySource.get(context.sourcePath) ?? 0;
                    if (now - lastAt < 1800) {
                        return;
                    }
                    this.lastMathDiagnosticsAtBySource.set(context.sourcePath, now);

                    const mathLinks = element.querySelectorAll('.math-link, .math-link.internal-link').length;
                    const virtualLinksInMath = element.querySelectorAll('.math .virtual-link-a, .math-block .virtual-link-a, .katex .virtual-link-a, mjx-container .virtual-link-a').length;
                    const obsidianMathAnchors = element.querySelectorAll('.math a[href^="obsidian://"], .math-block a[href^="obsidian://"], .katex a[href^="obsidian://"], mjx-container a[href^="obsidian://"], .MathJax a[href^="obsidian://"]').length;
                    const placeholderAnchors = element.querySelectorAll('a[href^="MathLinksID_"], a[href^="GlossaryMathID_"], a[data-mjx-href^="MathLinksID_"], a[data-mjx-href^="GlossaryMathID_"]').length;
                    this.logDebug(`Read-mode math diagnostics for ${context.sourcePath}`, {
                        mathBlocks,
                        mathLinks,
                        virtualLinksInMath,
                        obsidianMathAnchors,
                        placeholderAnchors,
                        usingMathLinksApi,
                    });
                    if (mathLinks === 0 && virtualLinksInMath === 0 && obsidianMathAnchors === 0 && placeholderAnchors === 0) {
                        this.logDebug(`No clickable math links found after render for ${context.sourcePath}`);
                    }
                }, 0);
            }
        });

        // Register the live linker for the live edit mode
        this.registerEditorExtension(liveLinkerPlugin(this.app, this.settings, this.updateManager));

        // This adds a settings tab so the user can configure various aspects of the plugin
        this.addSettingTab(new LinkerSettingTab(this.app, this));

        // Context menu item to convert virtual links to real links
        this.registerEvent(this.app.workspace.on('file-menu', (menu, file, source) => this.addContextMenuItem(menu, file, source)));

        // Editor context menu for AI glossary entry creation
        this.registerEvent(this.app.workspace.on('editor-menu', (menu, editor, view) => {
            if (this.settings.aiEnabled && editor.somethingSelected()) {
                menu.addItem((item) => {
                    item
                        .setTitle('Create Glossary Entry with AI')
                        .setIcon('sparkles')
                        .onClick(async () => {
                            const selectedText = editor.getSelection().trim();
                            if (!selectedText) return;

                            // Get surrounding context
                            const from = editor.getCursor('from');
                            const to = editor.getCursor('to');
                            const startLine = Math.max(0, from.line - 2);
                            const endLine = Math.min(editor.lineCount() - 1, to.line + 2);
                            let context = '';
                            for (let i = startLine; i <= endLine; i++) {
                                context += editor.getLine(i) + '\n';
                            }

                            const aiCreator = new AIEntryCreator(this.app, this.settings);
                            const file = await aiCreator.createEntryFromSelection(selectedText, context);
                            if (file) {
                                this.updateManager.update();
                            }
                        });
                });
            }
        }));

        // File watchers for auto-sync when glossary files change
        this.registerEvent(this.app.vault.on('create', (file) => {
            if (file instanceof TFile && file.extension === 'md') {
                LinkerCache.getInstance(this.app, this.settings).clearCache();
                this.updateManager.update();
            }
        }));

        this.registerEvent(this.app.vault.on('delete', (file) => {
            if (file instanceof TFile && file.extension === 'md') {
                LinkerCache.getInstance(this.app, this.settings).clearCache();
                this.updateManager.update();
            }
        }));

        this.registerEvent(this.app.vault.on('rename', (file) => {
            if (file instanceof TFile && file.extension === 'md') {
                LinkerCache.getInstance(this.app, this.settings).clearCache();
                this.updateManager.update();
            }
        }));

        this.registerEvent(this.app.metadataCache.on('changed', (file) => {
            // Triggered when file metadata (frontmatter/aliases) changes
            if (this.exactMatchBackfillRunning) {
                return;
            }
            LinkerCache.getInstance(this.app, this.settings).clearCache();
            this.updateManager.update();
        }));

        this.registerEvent(this.app.metadataCache.on('resolved', () => {
            this.virtualLinkMetadata?.handleMetadataResolvedEvent();
        }));

        this.virtualLinkMetadata?.scheduleRefresh('startup');

        this.addCommand({
            id: 'open-glossary-view',
            name: 'Open Glossary',
            callback: () => {
                this.activateGlossaryView();
            },
        });

        this.addCommand({
            id: 'activate-virtual-linker',
            name: 'Activate Glossary',
            checkCallback: (checking) => {
                if (!this.settings.linkerActivated) {
                    if (!checking) {
                        this.updateSettings({ linkerActivated: true });
                        this.updateManager.update();
                    }
                    return true;
                }
                return false;
            },
        });

        this.addCommand({
            id: 'deactivate-virtual-linker',
            name: 'Deactivate Glossary',
            checkCallback: (checking) => {
                if (this.settings.linkerActivated) {
                    if (!checking) {
                        this.updateSettings({ linkerActivated: false });
                        this.updateManager.update();
                    }
                    return true;
                }
                return false;
            },
        });

        this.addCommand({
            id: 'debug-log-virtual-link-metadata-current-file',
            name: 'Debug: Log virtual metadata for active file',
            callback: () => {
                this.logMetadataDiagnosticsForActiveFile();
            },
        });

        this.addCommand({
            id: 'convert-selected-virtual-links',
            name: 'Convert All Virtual Links in Selection to Real Links',
            checkCallback: (checking: boolean) => {
                const view = this.app.workspace.getActiveViewOfType(MarkdownView);
                const editor = view?.editor;

                if (!editor || !editor.somethingSelected()) {
                    return false;
                }

                if (checking) return true;

                // Get the selected text range
                const from = editor.getCursor('from');
                const to = editor.getCursor('to');

                // Get the DOM element containing the selection
                const cmEditor = (editor as any).cm;
                if (!cmEditor) return false;

                const selectionRange = cmEditor.dom.querySelector('.cm-content');
                if (!selectionRange) return false;

                // Find all virtual links in the selection
                const virtualLinks = Array.from(selectionRange.querySelectorAll('.virtual-link-a'))
                    .filter((link): link is HTMLElement => link instanceof HTMLElement)
                    .map(link => ({
                        element: link,
                        from: parseInt(link.getAttribute('from') || '-1'),
                        to: parseInt(link.getAttribute('to') || '-1'),
                        text: link.getAttribute('origin-text') || '',
                        href: link.getAttribute('href') || ''
                    }))
                    .filter(link => {
                        const linkFrom = editor.offsetToPos(link.from);
                        const linkTo = editor.offsetToPos(link.to);
                        return this.isPosWithinRange(linkFrom, linkTo, from, to);
                    })
                    .sort((a, b) => a.from - b.from);

                if (virtualLinks.length === 0) return;

                // Process all links in a single operation
                const replacements: { from: number, to: number, text: string }[] = [];

                for (const link of virtualLinks) {
                    const targetFile = this.app.vault.getAbstractFileByPath(link.href);
                    if (!(targetFile instanceof TFile)) continue;

                    const activeFile = this.app.workspace.getActiveFile();
                    const activeFilePath = activeFile?.path ?? '';

                    let absolutePath = targetFile.path;
                    let relativePath = path.relative(
                        path.dirname(activeFilePath),
                        path.dirname(absolutePath)
                    ) + '/' + path.basename(absolutePath);
                    relativePath = relativePath.replace(/\\/g, '/');

                    const replacementPath = this.app.metadataCache.fileToLinktext(targetFile, activeFilePath);
                    const lastPart = replacementPath.split('/').pop()!;
                    const shortestFile = this.app.metadataCache.getFirstLinkpathDest(lastPart!, '');
                    let shortestPath = shortestFile?.path === targetFile.path ? lastPart : absolutePath;

                    // Remove .md extension if needed
                    if (!replacementPath.endsWith('.md')) {
                        if (absolutePath.endsWith('.md')) absolutePath = absolutePath.slice(0, -3);
                        if (shortestPath.endsWith('.md')) shortestPath = shortestPath.slice(0, -3);
                        if (relativePath.endsWith('.md')) relativePath = relativePath.slice(0, -3);
                    }

                    const useMarkdownLinks = this.settings.useDefaultLinkStyleForConversion
                        ? this.settings.defaultUseMarkdownLinks
                        : this.settings.useMarkdownLinks;

                    const linkFormat = this.settings.useDefaultLinkStyleForConversion
                        ? this.settings.defaultLinkFormat
                        : this.settings.linkFormat;

                    let replacement = '';
                    if (replacementPath === link.text && linkFormat === 'shortest') {
                        replacement = `[[${replacementPath}]]`;
                    } else {
                        const path = linkFormat === 'shortest' ? shortestPath :
                            linkFormat === 'relative' ? relativePath :
                                absolutePath;

                        replacement = useMarkdownLinks ?
                            `[${link.text}](${path})` :
                            `[[${path}|${link.text}]]`;
                    }

                    replacements.push({
                        from: link.from,
                        to: link.to,
                        text: replacement
                    });
                }

                // Apply all replacements in reverse order to maintain correct positions
                for (const replacement of replacements.reverse()) {
                    const fromPos = editor.offsetToPos(replacement.from);
                    const toPos = editor.offsetToPos(replacement.to);
                    editor.replaceRange(replacement.text, fromPos, toPos);
                }
            }
        });

        // AI-powered glossary entry creation command
        this.addCommand({
            id: 'create-glossary-entry-with-ai',
            name: 'Create Glossary Entry with AI from Selection',
            editorCheckCallback: (checking, editor, view) => {
                if (!this.settings.aiEnabled) {
                    return false;
                }
                if (!editor.somethingSelected()) {
                    return false;
                }
                if (checking) return true;

                const selectedText = editor.getSelection().trim();
                if (!selectedText) return;

                // Get surrounding context (2 lines before and after selection)
                const from = editor.getCursor('from');
                const to = editor.getCursor('to');
                const startLine = Math.max(0, from.line - 2);
                const endLine = Math.min(editor.lineCount() - 1, to.line + 2);
                let context = '';
                for (let i = startLine; i <= endLine; i++) {
                    context += editor.getLine(i) + '\n';
                }

                const aiCreator = new AIEntryCreator(this.app, this.settings);
                aiCreator.createEntryFromSelection(selectedText, context).then(file => {
                    if (file) {
                        this.updateManager.update();
                    }
                });
            }
        });

    }

    private logDebug(message: string, details?: unknown) {
        if (!this.settings.debugLogging) {
            return;
        }
        if (details === undefined) {
            console.log(`[Glossary][Debug] ${message}`);
        } else {
            console.log(`[Glossary][Debug] ${message}`, details);
        }
    }

    private logMathLinkerStatus(): boolean {
        const appAny = this.app as any;
        const plugins = appAny?.plugins?.plugins ?? {};
        const pluginEntries = Object.entries<any>(plugins);
        const exactIdMatch = plugins['math-links'] ?? plugins['Math-Links'] ?? plugins['MathLinks'];
        const heuristicMatch = pluginEntries
            .map(([, plugin]) => plugin)
            .find((plugin) => {
                const id = String(plugin?.manifest?.id ?? '').toLowerCase();
                const name = String(plugin?.manifest?.name ?? '').toLowerCase();
                return (id.includes('math') && id.includes('link')) || (name.includes('math') && name.includes('link'));
            });
        const mathLinks = exactIdMatch ?? heuristicMatch;

        if (mathLinks) {
            this.logDebug('Math Links plugin detected', {
                id: mathLinks?.manifest?.id,
                version: mathLinks?.manifest?.version,
            });
            return true;
        } else {
            this.logDebug('Math Links plugin not detected at layout-ready time', {
                loadedPluginIds: pluginEntries.slice(0, 60).map(([id]) => id),
                totalLoadedPlugins: pluginEntries.length,
            });
            return false;
        }
    }

    private getMathLinksApi(): ExternalMathLinksApi | null {
        const api = (window as Window).MathLinksAPI;
        if (!api) {
            return null;
        }
        return api;
    }

    private setupMathLinksApiIntegration(): void {
        this.app.workspace.onLayoutReady(() => {
            this.tryAttachMathLinksApiRewriter('layout-ready');
            [220, 900, 2100].forEach((delay) => {
                window.setTimeout(() => this.tryAttachMathLinksApiRewriter(`layout-retry-${delay}ms`), delay);
            });
            this.registerInterval(window.setInterval(() => this.tryAttachMathLinksApiRewriter('periodic-watchdog'), 2400));
        });
    }

    private tryAttachMathLinksApiRewriter(reason: string): boolean {
        if (this.didAttachMathLinksApiRewriter) {
            return true;
        }

        const api = this.getMathLinksApi();
        if (!api || typeof api.registerSourceRewriter !== 'function' || typeof api.createPlaceholder !== 'function') {
            if (!this.didLogMathLinksApiUnavailable) {
                this.didLogMathLinksApiUnavailable = true;
                this.logDebug('MathLinksAPI unavailable; keeping local math rewrite fallback active');
            }
            return false;
        }

        this.didLogMathLinksApiUnavailable = false;
        api.registerSourceRewriter(this.mathLinksGlossaryRewriterId, (source, context) => {
            const sourcePath = String(context?.sourcePath ?? this.app.workspace.getActiveFile()?.path ?? '');
            const rewritten = this.rewriteGlossaryTermsInMathSource(
                String(source ?? ''),
                sourcePath,
                (linkText) => api.createPlaceholder?.(linkText, this.glossaryMathPlaceholderPrefix) ?? this.createGlossaryMathPlaceholder(linkText)
            );
            return rewritten.source;
        });
        this.didAttachMathLinksApiRewriter = true;
        this.logDebug('Registered glossary math source rewriter with MathLinksAPI', {
            reason,
            mathLinksApiVersion: api.version ?? 'unknown',
            rewriterId: this.mathLinksGlossaryRewriterId,
        });
        return true;
    }

    private patchMathRenderers(): void {
        this.app.workspace.onLayoutReady(() => {
            const runFallbackPatch = (reason: string) => {
                if (this.didAttachMathLinksApiRewriter || this.tryAttachMathLinksApiRewriter(`fallback-check:${reason}`)) {
                    return;
                }
                this.ensureKatexRendererPatched(reason);
                this.ensureMathJaxRenderersPatched(reason);
            };

            // Try immediately at layout-ready before any rendering
            runFallbackPatch('layout-ready-immediate');
            window.setTimeout(() => runFallbackPatch('layout-delayed-50ms'), 50);
            window.setTimeout(() => runFallbackPatch('layout-delayed-300ms'), 300);
            [900, 2100].forEach((delay) => {
                window.setTimeout(() => {
                    runFallbackPatch(`layout-retry-${delay}ms`);
                }, delay);
            });
            this.registerInterval(window.setInterval(() => {
                runFallbackPatch('periodic-watchdog');
            }, 2400));
        });
    }

    private ensureKatexRendererPatched(reason: string): void {
        if (this.didAttachMathLinksApiRewriter) {
            return;
        }
        const katex = (window as any)?.katex;
        if (!katex || typeof katex.render !== 'function') {
            if (!this.didLogKatexRendererUnavailable) {
                this.didLogKatexRendererUnavailable = true;
                this.logDebug('KaTeX renderer unavailable for glossary math patch');
            }
            return;
        }

        this.didLogKatexRendererUnavailable = false;

        type KatexRenderFunction = ((tex: string, element: HTMLElement, options?: any) => unknown) & {
            __glossaryMathWrapped?: boolean;
            __glossaryMathWrappedBy?: string;
        };

        const currentRender = katex.render as KatexRenderFunction;
        if (currentRender.__glossaryMathWrapped && currentRender.__glossaryMathWrappedBy === 'virtual-linker') {
            return;
        }

        const originalRender = currentRender.bind(katex);
        const wrappedRender = ((tex: string, element: HTMLElement, options?: any) => {
            const sourcePath = this.app.workspace.getActiveFile()?.path ?? '';
            const rewritten = this.rewriteMathSourceWithLinks(tex, sourcePath);
            const nextTex = rewritten.count > 0 ? rewritten.source : tex;

            const newOptions = { ...(options ?? {}) };
            const previousTrust = newOptions.trust;
            newOptions.trust = (context: { command: string; protocol?: string; url?: string }) => {
                if (context.command === '\\href') {
                    const protocol = String(context.protocol ?? '');
                    const url = String(context.url ?? '');
                    if (
                        protocol === 'obsidian:' ||
                        url.startsWith('obsidian://') ||
                        url.startsWith('MathLinksID_') ||
                        url.startsWith(this.glossaryMathPlaceholderPrefix)
                    ) {
                        return true;
                    }
                }
                if (typeof previousTrust === 'function') {
                    return previousTrust(context);
                }
                return !!previousTrust;
            };

            const result = originalRender(nextTex, element, newOptions);
            if (rewritten.count > 0) {
                this.bindMathLinkAnchors(element, sourcePath);
            }
            return result;
        }) as KatexRenderFunction;

        wrappedRender.__glossaryMathWrapped = true;
        wrappedRender.__glossaryMathWrappedBy = 'virtual-linker';
        katex.render = wrappedRender;

        this.logDebug('Patched KaTeX renderer for glossary math term linking', { reason });
        this.scheduleActiveViewMathRefresh();
    }

    private scheduleActiveViewMathRefresh(): void {
        window.setTimeout(() => {
            const leaves = this.app.workspace.getLeavesOfType('markdown');
            for (const leaf of leaves) {
                const view = leaf.view;
                if (view instanceof MarkdownView) {
                    const contentEl = view.contentEl;
                    const sourcePath = (view as any).file?.path ?? '';
                    this.enhanceMathContent(contentEl, sourcePath);
                    this.bindMathLinkAnchors(contentEl, sourcePath);
                }
            }
        }, 80);
    }

    private ensureMathJaxRenderersPatched(reason: string): void {
        if (this.didAttachMathLinksApiRewriter) {
            return;
        }
        const mathJax = (window as any)?.MathJax;
        const hasPatchableRenderer =
            !!mathJax &&
            (
                typeof mathJax.tex2chtml === 'function' ||
                typeof mathJax.tex2svg === 'function' ||
                typeof mathJax.tex2chtmlPromise === 'function' ||
                typeof mathJax.tex2svgPromise === 'function' ||
                typeof mathJax.typeset === 'function' ||
                typeof mathJax.typesetPromise === 'function'
            );

        if (!hasPatchableRenderer) {
            if (!this.didLogMathJaxRendererUnavailable) {
                this.didLogMathJaxRendererUnavailable = true;
                this.logDebug('MathJax renderer unavailable for glossary math patch');
            }
            return;
        }

        this.didLogMathJaxRendererUnavailable = false;

        type WrappedMathJaxFn = ((...args: any[]) => any) & {
            __glossaryMathWrapped?: boolean;
            __glossaryMathWrappedBy?: string;
        };

        const patchedFunctions: string[] = [];

        const patchTexRenderer = (key: 'tex2chtml' | 'tex2svg' | 'tex2chtmlPromise' | 'tex2svgPromise') => {
            const current = mathJax[key] as WrappedMathJaxFn | undefined;
            if (typeof current !== 'function') {
                return;
            }
            if (current.__glossaryMathWrapped && current.__glossaryMathWrappedBy === 'virtual-linker') {
                return;
            }

            const original = current.bind(mathJax);
            const wrapped = ((latex: string, options?: any) => {
                const sourcePath = this.app.workspace.getActiveFile()?.path ?? '';
                const rewritten = this.rewriteMathSourceWithLinks(String(latex ?? ''), sourcePath);
                const nextLatex = rewritten.count > 0 ? rewritten.source : latex;
                const result = original(nextLatex, options);

                if (result && typeof result.then === 'function') {
                    return result.then((node: unknown) => {
                        if (node instanceof HTMLElement) {
                            this.bindMathLinkAnchors(node, sourcePath);
                        }
                        return node;
                    });
                }

                if (result instanceof HTMLElement) {
                    this.bindMathLinkAnchors(result, sourcePath);
                }
                return result;
            }) as WrappedMathJaxFn;

            wrapped.__glossaryMathWrapped = true;
            wrapped.__glossaryMathWrappedBy = 'virtual-linker';
            mathJax[key] = wrapped;
            patchedFunctions.push(key);
        };

        const patchTypesetRenderer = (key: 'typeset' | 'typesetPromise') => {
            const current = mathJax[key] as WrappedMathJaxFn | undefined;
            if (typeof current !== 'function') {
                return;
            }
            if (current.__glossaryMathWrapped && current.__glossaryMathWrappedBy === 'virtual-linker') {
                return;
            }

            const original = current.bind(mathJax);
            const wrapped = ((elements?: HTMLElement[]) => {
                const sourcePath = this.app.workspace.getActiveFile()?.path ?? '';
                const targets = Array.isArray(elements) && elements.length > 0
                    ? elements.filter((el) => el instanceof HTMLElement)
                    : [];

                let rewriteCount = 0;
                targets.forEach((target) => {
                    rewriteCount += this.rewriteMathSourcesInContainer(target, sourcePath);
                });

                if (rewriteCount > 0) {
                    this.logDebug('Prepared MathJax source rewrites before typeset', {
                        sourcePath,
                        rewriteCount,
                        renderer: key,
                    });
                }

                const result = original(elements);
                const bindTargets = targets.length > 0
                    ? targets
                    : (document.body instanceof HTMLElement ? [document.body] : []);

                if (result && typeof result.then === 'function') {
                    return result.then((value: unknown) => {
                        bindTargets.forEach((target) => this.bindMathLinkAnchors(target, sourcePath));
                        return value;
                    });
                }

                bindTargets.forEach((target) => this.bindMathLinkAnchors(target, sourcePath));
                return result;
            }) as WrappedMathJaxFn;

            wrapped.__glossaryMathWrapped = true;
            wrapped.__glossaryMathWrappedBy = 'virtual-linker';
            mathJax[key] = wrapped;
            patchedFunctions.push(key);
        };

        patchTexRenderer('tex2chtml');
        patchTexRenderer('tex2svg');
        patchTexRenderer('tex2chtmlPromise');
        patchTexRenderer('tex2svgPromise');
        patchTypesetRenderer('typeset');
        patchTypesetRenderer('typesetPromise');

        if (patchedFunctions.length > 0) {
            this.logDebug('Patched MathJax renderer(s) for glossary math term linking', {
                reason,
                functions: patchedFunctions,
            });
        }
    }

    private rewriteMathSourcesInContainer(root: HTMLElement, sourcePath: string): number {
        const candidates = new Set<HTMLElement>();
        if (root.matches('[data-math], [data-expression], .math, .math-block')) {
            candidates.add(root);
        }
        root.querySelectorAll<HTMLElement>('[data-math], [data-expression], .math, .math-block').forEach((element) => {
            candidates.add(element);
        });

        let rewrittenCount = 0;
        candidates.forEach((candidate) => {
            const sourceMeta = this.getMathSourceMeta(candidate);
            if (!sourceMeta || !sourceMeta.source) {
                return;
            }
            const rewritten = this.rewriteMathSourceWithLinks(sourceMeta.source, sourcePath);
            if (rewritten.count === 0 || rewritten.source === sourceMeta.source) {
                return;
            }
            sourceMeta.sourceHost.setAttribute(sourceMeta.sourceAttr, rewritten.source);
            rewrittenCount += rewritten.count;
        });

        return rewrittenCount;
    }

    private enhanceMathContent(root: HTMLElement, sourcePath: string): void {
        const mathElements = root.querySelectorAll<HTMLElement>('.math, .math-block');
        if (mathElements.length === 0) {
            return;
        }

        let rewrittenCount = 0;
        for (const mathElement of Array.from(mathElements)) {
            const sourceMeta = this.getMathSourceMeta(mathElement);
            if (!sourceMeta || !sourceMeta.source) {
                continue;
            }

            const rewritten = this.rewriteMathSourceWithLinks(sourceMeta.source, sourcePath);
            if (rewritten.count === 0 || rewritten.source === sourceMeta.source) {
                continue;
            }

            sourceMeta.sourceHost.setAttribute(sourceMeta.sourceAttr, rewritten.source);
            const rendered = this.renderMathElement(mathElement, rewritten.source, sourceMeta.displayMode);
            if (rendered) {
                rewrittenCount += rewritten.count;
                this.logDebug(`Re-rendered math block with ${rewritten.count} glossary replacements`, {
                    sourcePath,
                    sourceAttr: sourceMeta.sourceAttr,
                    wikiLinks: rewritten.wikiLinkCount,
                    glossaryTerms: rewritten.termLinkCount,
                });
            } else {
                this.logDebug('Math link rewrite prepared but no renderer was available', {
                    sourcePath,
                    sourceAttr: sourceMeta.sourceAttr,
                });
            }
        }

        if (rewrittenCount > 0) {
            this.bindMathLinkAnchors(root, sourcePath);
            this.logDebug(`Applied ${rewrittenCount} math glossary replacements in ${sourcePath}`);
        }
    }

    private getMathSourceMeta(mathElement: HTMLElement): { source: string; sourceHost: HTMLElement; sourceAttr: 'data-math' | 'data-expression'; displayMode: boolean } | null {
        const displayMode = mathElement.classList.contains('math-block');

        if (mathElement.hasAttribute('data-math')) {
            return {
                source: mathElement.getAttribute('data-math') ?? '',
                sourceHost: mathElement,
                sourceAttr: 'data-math',
                displayMode,
            };
        }
        if (mathElement.hasAttribute('data-expression')) {
            return {
                source: mathElement.getAttribute('data-expression') ?? '',
                sourceHost: mathElement,
                sourceAttr: 'data-expression',
                displayMode,
            };
        }

        const parent = mathElement.parentElement as HTMLElement | null;
        if (!parent) {
            return null;
        }
        if (parent.hasAttribute('data-math')) {
            return {
                source: parent.getAttribute('data-math') ?? '',
                sourceHost: parent,
                sourceAttr: 'data-math',
                displayMode,
            };
        }
        if (parent.hasAttribute('data-expression')) {
            return {
                source: parent.getAttribute('data-expression') ?? '',
                sourceHost: parent,
                sourceAttr: 'data-expression',
                displayMode,
            };
        }
        return null;
    }

    private rewriteMathSourceWithLinks(source: string, sourcePath: string): { source: string; count: number; wikiLinkCount: number; termLinkCount: number } {
        const wikiRewrite = this.rewriteWikiLinksInMathSource(source, sourcePath);
        const termRewrite = this.rewriteGlossaryTermsInMathSource(wikiRewrite.source, sourcePath);
        return {
            source: termRewrite.source,
            count: wikiRewrite.count + termRewrite.count,
            wikiLinkCount: wikiRewrite.count,
            termLinkCount: termRewrite.count,
        };
    }

    private rewriteWikiLinksInMathSource(source: string, sourcePath: string): { source: string; count: number } {
        let count = 0;
        const wikiLinkPattern = /\[\[([^|\]]+)(?:\|([^\]]+))?\]\]/g;
        const rewrittenSource = source.replace(wikiLinkPattern, (full, targetRaw: string, displayRaw: string | undefined) => {
            const target = (targetRaw ?? '').trim();
            const display = (displayRaw ?? targetRaw ?? '').trim();
            if (!target || !display) {
                return full;
            }
            const resolvedFile = this.app.metadataCache.getFirstLinkpathDest(getLinkpath(target), sourcePath);
            const targetLinkText = resolvedFile
                ? this.app.metadataCache.fileToLinktext(resolvedFile, sourcePath) || resolvedFile.path.replace(/\.md$/i, '')
                : target;
            const placeholderId = this.createGlossaryMathPlaceholder(targetLinkText);
            count += 1;
            return `\\href{${placeholderId}}{\\text{${this.escapeLatexText(display)}}}`;
        });
        return { source: rewrittenSource, count };
    }

    private rewriteGlossaryTermsInMathSource(
        source: string,
        sourcePath: string,
        createPlaceholder?: (linkText: string) => string
    ): { source: string; count: number } {
        const matches = this.collectGlossaryMathMatches(source, sourcePath);
        if (matches.length === 0) {
            return { source, count: 0 };
        }

        let rewrittenSource = source;
        let rewrittenCount = 0;
        const textRanges = this.findLatexCommandRanges(source, 'text');

        for (const match of [...matches].sort((a, b) => b.from - a.from)) {
            const linkText = this.app.metadataCache.fileToLinktext(match.target, sourcePath) || match.target.path.replace(/\.md$/i, '');
            const placeholderId = createPlaceholder ? createPlaceholder(linkText) : this.createGlossaryMathPlaceholder(linkText);
            const isInTextCommand = this.isRangeInsideAny(match.from, match.to, textRanges);
            const hasLatexCommands = /\\[a-zA-Z]/.test(match.text);
            const replacement = (isInTextCommand && !hasLatexCommands)
                ? `\\href{${placeholderId}}{${this.escapeLatexText(match.text)}}`
                : `\\href{${placeholderId}}{${match.text}}`;

            rewrittenSource =
                rewrittenSource.slice(0, match.from) +
                replacement +
                rewrittenSource.slice(match.to);
            rewrittenCount += 1;
        }

        return { source: rewrittenSource, count: rewrittenCount };
    }

    private normalizeMathComparableText(value: string): string {
        let out = String(value ?? '').normalize('NFKC');

        let previous = '';
        while (previous !== out) {
            previous = out;
            out = out.replace(/\\[a-zA-Z]+\*?\{([^{}]*)\}/g, '$1');
        }

        out = out
            .replace(/\$+/g, ' ')
            .replace(/\\[a-zA-Z]+\*?/g, ' ')
            .replace(/[{}[\]()]/g, ' ')
            .replace(/[^\p{L}\p{N}\s\-_]/gu, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();

        return out;
    }

    private getFileMatchNames(file: TFile): string[] {
        const names = [file.basename];
        if (!this.settings.includeAliases) {
            return names;
        }

        const frontmatterAliases = this.app.metadataCache.getFileCache(file)?.frontmatter?.aliases;
        const aliases = Array.isArray(frontmatterAliases)
            ? frontmatterAliases
            : frontmatterAliases != null
                ? [frontmatterAliases]
                : [];

        aliases
            .map((alias) => String(alias ?? '').trim())
            .filter((alias) => alias.length > 0)
            .forEach((alias) => names.push(alias));

        return names;
    }

    private isLikelyMathStyledName(name: string): boolean {
        return /[\\${}]/.test(name);
    }

    private buildMathContainmentCandidates(sourceFile: TFile | null): Array<{ file: TFile; variants: string[] }> {
        const linkerCache = LinkerCache.getInstance(this.app, this.settings);
        const out: Array<{ file: TFile; variants: string[] }> = [];

        linkerCache.cache.setIndexedFilePaths.forEach((path) => {
            const file = this.app.vault.getFileByPath(path);
            if (!file) {
                return;
            }
            if (this.settings.excludeLinksToOwnNote && sourceFile && file.path === sourceFile.path) {
                return;
            }

            const variants = new Set<string>();
            this.getFileMatchNames(file).forEach((name) => {
                const normalized = this.normalizeMathComparableText(name);
                if (normalized.length > 0) {
                    variants.add(normalized);
                }
            });

            if (variants.size > 0) {
                out.push({
                    file,
                    variants: Array.from(variants),
                });
            }
        });

        return out;
    }

    private findContainmentFilesForMathText(
        text: string,
        candidates: Array<{ file: TFile; variants: string[] }>,
        linkerCache: LinkerCache
    ): TFile[] {
        const normalizedText = this.normalizeMathComparableText(text);
        if (!normalizedText) {
            return [];
        }

        const out: TFile[] = [];
        const requireExactOnlyPath = linkerCache.cache.mapFilePathToExactMatchOnly;

        candidates.forEach((candidate) => {
            const exactOnly = requireExactOnlyPath.get(candidate.file.path) === true;

            for (const variant of candidate.variants) {
                if (!variant) {
                    continue;
                }

                const exactMatch = variant === normalizedText;
                const allowContainment = variant.length >= 4 && normalizedText.length >= 4;
                const containmentMatch = allowContainment && (variant.includes(normalizedText) || normalizedText.includes(variant));
                const isMatch = exactMatch || containmentMatch;

                if (!isMatch) {
                    continue;
                }
                if (exactOnly && !exactMatch) {
                    continue;
                }

                out.push(candidate.file);
                return;
            }
        });

        return out;
    }

    private choosePreferredMathTarget(files: TFile[], matchedText: string): TFile | null {
        if (files.length === 0) {
            return null;
        }
        if (files.length === 1) {
            return files[0];
        }

        const normalizedText = this.normalizeMathComparableText(matchedText);
        const uniqueFiles = Array.from(new Map(files.map((file) => [file.path, file])).values());

        const scoreFile = (file: TFile): number => {
            const normalizedBasename = this.normalizeMathComparableText(file.basename);
            let score = 0;

            if (file.basename.toLowerCase() === matchedText.toLowerCase()) {
                score += 120;
            }
            if (normalizedBasename && normalizedBasename === normalizedText) {
                score += 80;
            }

            const aliases = this.getFileMatchNames(file).slice(1);
            if (aliases.some((alias) => alias.toLowerCase() === matchedText.toLowerCase())) {
                score += 40;
            }
            if (!this.isLikelyMathStyledName(file.basename)) {
                score += 10;
            }

            score -= Math.min(20, Math.floor(file.basename.length / 8));
            return score;
        };

        uniqueFiles.sort((a, b) => {
            const scoreDiff = scoreFile(b) - scoreFile(a);
            if (scoreDiff !== 0) {
                return scoreDiff;
            }
            return a.path.localeCompare(b.path);
        });

        return uniqueFiles[0] ?? null;
    }

    private collectGlossaryMathMatches(source: string, sourcePath: string): Array<{ from: number; to: number; text: string; target: TFile }> {
        const linkerCache = LinkerCache.getInstance(this.app, this.settings);
        linkerCache.reset();

        const excludedRanges = this.collectMathExcludedRanges(source);
        const sourceFile = this.resolveSourceFile(sourcePath);
        const containmentCandidates = this.buildMathContainmentCandidates(sourceFile);
        const out: Array<{ from: number; to: number; text: string; target: TFile }> = [];

        let i = 0;
        while (i <= source.length) {
            const codePoint = source.codePointAt(i);
            const char = i < source.length && codePoint !== undefined ? String.fromCodePoint(codePoint) : '\n';
            const isWordBoundary = PrefixTree.checkWordBoundary(char);

            if (this.settings.matchAnyPartsOfWords || this.settings.matchBeginningOfWords || isWordBoundary) {
                const currentNodes = linkerCache.cache.getCurrentMatchNodes(
                    i,
                    this.settings.excludeLinksToOwnNote ? sourceFile : null
                );

                currentNodes.forEach((node) => {
                    if (
                        !this.settings.matchAnyPartsOfWords &&
                        this.settings.matchBeginningOfWords &&
                        !node.startsAtWordBoundary &&
                        this.settings.matchEndOfWords &&
                        !isWordBoundary
                    ) {
                        return;
                    }

                    const nFrom = node.start;
                    const nTo = node.end;
                    if (nTo <= nFrom || nFrom < 0 || nTo > source.length) {
                        return;
                    }

                    if (nFrom > 0 && source[nFrom - 1] === '\\') {
                        return;
                    }

                    if (this.rangeIntersectsAny(nFrom, nTo, excludedRanges)) {
                        return;
                    }

                    const filteredFiles = linkerCache.cache.filterFilesByMatchBoundaries(
                        node.files,
                        node.startsAtWordBoundary,
                        isWordBoundary
                    );
                    const text = source.slice(nFrom, nTo);
                    const containmentFiles = this.findContainmentFilesForMathText(text, containmentCandidates, linkerCache);
                    const mergedCandidates = Array.from(
                        new Map([...filteredFiles, ...containmentFiles].map((file) => [file.path, file])).values()
                    );
                    const target = this.choosePreferredMathTarget(mergedCandidates, text);
                    if (!target) {
                        return;
                    }

                    out.push({ from: nFrom, to: nTo, text, target });
                });
            }

            linkerCache.cache.pushChar(char);
            i += char.length;
        }

        // Search for LaTeX-styled glossary names (containing \, {, }) literally in the math source.
        // The PrefixTree splits on these characters so it can only match fragments;
        // this pass finds the full LaTeX name as a single match.
        const literalLatexMatches = this.collectLiteralLatexMathMatches(source, excludedRanges, sourceFile);
        out.push(...literalLatexMatches);

        if (out.length === 0) {
            const fallbackMatches = this.collectContainmentFallbackMathMatches(
                source,
                excludedRanges,
                containmentCandidates,
                linkerCache
            );
            out.push(...fallbackMatches);
        }

        out.sort((a, b) => {
            if (a.from === b.from) {
                return (b.to - b.from) - (a.to - a.from);
            }
            return a.from - b.from;
        });

        const nonOverlapping: Array<{ from: number; to: number; text: string; target: TFile }> = [];
        let lastEnd = -1;
        for (const match of out) {
            if (match.from < lastEnd) {
                continue;
            }
            nonOverlapping.push(match);
            lastEnd = match.to;
        }

        return nonOverlapping;
    }

    private collectLiteralLatexMathMatches(
        source: string,
        excludedRanges: Array<[number, number]>,
        sourceFile: TFile | null
    ): Array<{ from: number; to: number; text: string; target: TFile }> {
        const linkerCache = LinkerCache.getInstance(this.app, this.settings);
        const out: Array<{ from: number; to: number; text: string; target: TFile }> = [];

        linkerCache.cache.setIndexedFilePaths.forEach((filePath) => {
            const file = this.app.vault.getFileByPath(filePath);
            if (!file) return;
            if (this.settings.excludeLinksToOwnNote && sourceFile && file.path === sourceFile.path) return;

            const names = this.getFileMatchNames(file);
            for (const name of names) {
                if (!this.isLikelyMathStyledName(name)) continue;
                if (name.length < 3) continue;

                // Search for this LaTeX-styled name literally in the math source
                let searchFrom = 0;
                while (searchFrom < source.length) {
                    const idx = source.indexOf(name, searchFrom);
                    if (idx === -1) break;

                    const from = idx;
                    const to = idx + name.length;

                    if (!this.rangeIntersectsAny(from, to, excludedRanges)) {
                        out.push({ from, to, text: name, target: file });
                    }

                    searchFrom = idx + 1;
                }
            }
        });

        return out;
    }

    private collectContainmentFallbackMathMatches(
        source: string,
        excludedRanges: Array<[number, number]>,
        containmentCandidates: Array<{ file: TFile; variants: string[] }>,
        linkerCache: LinkerCache
    ): Array<{ from: number; to: number; text: string; target: TFile }> {
        const out: Array<{ from: number; to: number; text: string; target: TFile }> = [];
        const seen = new Set<string>();
        const tokenPattern = /[\p{L}\p{N}][\p{L}\p{N}\-_]{1,}/gu;

        let match: RegExpExecArray | null;
        while ((match = tokenPattern.exec(source)) !== null) {
            const text = match[0] ?? '';
            const from = match.index;
            const to = from + text.length;
            if (!text || to <= from) {
                continue;
            }
            if (this.rangeIntersectsAny(from, to, excludedRanges)) {
                continue;
            }

            // Ignore LaTeX command names (e.g. \text, \frac).
            if (from > 0 && source[from - 1] === '\\') {
                continue;
            }

            const containmentFiles = this.findContainmentFilesForMathText(text, containmentCandidates, linkerCache);
            const target = this.choosePreferredMathTarget(containmentFiles, text);
            if (!target) {
                continue;
            }

            const key = `${from}:${to}:${target.path}`;
            if (seen.has(key)) {
                continue;
            }
            seen.add(key);
            out.push({ from, to, text, target });
        }

        return out;
    }

    private resolveSourceFile(sourcePath: string): TFile | null {
        if (!sourcePath) {
            return this.app.workspace.getActiveFile() ?? null;
        }
        const direct = this.app.vault.getFileByPath(sourcePath);
        if (direct) {
            return direct;
        }
        const resolved = this.app.metadataCache.getFirstLinkpathDest(getLinkpath(sourcePath), '');
        return resolved ?? this.app.workspace.getActiveFile() ?? null;
    }

    private collectMathExcludedRanges(source: string): Array<[number, number]> {
        const ranges: Array<[number, number]> = [];
        const patterns: RegExp[] = [
            /\\href\{[^}]*\}\{[^}]*\}/g,
            /obsidian:\/\/[^\s}]+/g,
            /\[\[[^\]]+\]\]/g,
        ];

        patterns.forEach((pattern) => {
            pattern.lastIndex = 0;
            let match: RegExpExecArray | null;
            while ((match = pattern.exec(source)) !== null) {
                const start = match.index;
                const end = start + match[0].length;
                if (end > start) {
                    ranges.push([start, end]);
                }
                if (match.index === pattern.lastIndex) {
                    pattern.lastIndex += 1;
                }
            }
        });

        return ranges;
    }

    private findLatexCommandRanges(source: string, command: string): Array<[number, number]> {
        const ranges: Array<[number, number]> = [];
        const marker = `\\${command}{`;
        let from = 0;

        while (from < source.length) {
            const start = source.indexOf(marker, from);
            if (start === -1) {
                break;
            }
            const braceStart = start + marker.length - 1;
            let depth = 0;
            let end = -1;

            for (let i = braceStart; i < source.length; i++) {
                const ch = source[i];
                if (ch === '{') {
                    depth += 1;
                } else if (ch === '}') {
                    depth -= 1;
                    if (depth === 0) {
                        end = i;
                        break;
                    }
                }
            }

            if (end !== -1 && end > braceStart + 1) {
                ranges.push([braceStart + 1, end]);
                from = end + 1;
            } else {
                from = braceStart + 1;
            }
        }

        return ranges;
    }

    private rangeIntersectsAny(from: number, to: number, ranges: Array<[number, number]>): boolean {
        return ranges.some(([rangeFrom, rangeTo]) => from < rangeTo && to > rangeFrom);
    }

    private isRangeInsideAny(from: number, to: number, ranges: Array<[number, number]>): boolean {
        return ranges.some(([rangeFrom, rangeTo]) => from >= rangeFrom && to <= rangeTo);
    }

    private renderMathElement(mathElement: HTMLElement, source: string, displayMode: boolean): boolean {
        const katexRender = (window as any)?.katex?.render;
        if (typeof katexRender !== 'function') {
            const mathJax = (window as any)?.MathJax;
            try {
                mathElement.setAttribute('data-math', source);
                mathElement.setAttribute('data-expression', source);
                if (typeof mathJax?.typesetPromise === 'function') {
                    void mathJax.typesetPromise([mathElement]);
                    return true;
                }
                if (typeof mathJax?.typeset === 'function') {
                    mathJax.typeset([mathElement]);
                    return true;
                }
            } catch (error) {
                this.logDebug('Failed to render rewritten math element with MathJax fallback', { error: String(error) });
            }
            return false;
        }

        try {
            while (mathElement.firstChild) {
                mathElement.removeChild(mathElement.firstChild);
            }
            katexRender(source, mathElement, {
                displayMode,
                throwOnError: false,
                strict: false,
                trust: (context: { command: string; url?: string; protocol?: string }) => {
                    if (context.command !== '\\href') {
                        return false;
                    }
                    const protocol = String(context.protocol ?? '');
                    const url = String(context.url ?? '');
                    return (
                        protocol === 'obsidian:' ||
                        url.startsWith('obsidian://') ||
                        url.startsWith('MathLinksID_') ||
                        url.startsWith(this.glossaryMathPlaceholderPrefix)
                    );
                },
            });
            return true;
        } catch (error) {
            this.logDebug('Failed to render rewritten math element', { error: String(error) });
            return false;
        }
    }

    private buildObsidianFileUrl(filePath: string): string {
        const encodedVault = encodeURIComponent(this.app.vault.getName());
        const encodedFile = encodeURIComponent(filePath);
        return `obsidian://open?vault=${encodedVault}&file=${encodedFile}`;
    }

    private createGlossaryMathPlaceholder(linkText: string): string {
        const id = `${this.glossaryMathPlaceholderPrefix}${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
        this.glossaryMathLinkTargets.set(id, {
            linkText,
            url: this.buildObsidianFileUrl(linkText),
            createdAt: Date.now(),
        });

        if (this.glossaryMathLinkTargets.size > 3000) {
            const cutoff = Date.now() - 20 * 60 * 1000;
            for (const [key, value] of this.glossaryMathLinkTargets) {
                if (value.createdAt < cutoff) {
                    this.glossaryMathLinkTargets.delete(key);
                }
            }
        }

        return id;
    }

    private escapeLatexText(text: string): string {
        return text
            .replace(/\\/g, '\\textbackslash{}')
            .replace(/([#$%&_{}])/g, '\\$1')
            .replace(/\^/g, '\\textasciicircum{}')
            .replace(/~/g, '\\textasciitilde{}');
    }

    private bindMathLinkAnchors(root: HTMLElement, sourcePath: string): void {
        const mathAnchors = root.querySelectorAll<HTMLAnchorElement>(
            `a.math-link, a[href^="${this.glossaryMathPlaceholderPrefix}"], a[data-mjx-href^="${this.glossaryMathPlaceholderPrefix}"], a[href^="MathLinksID_"], a[data-mjx-href^="MathLinksID_"], .math a[href^="obsidian://"], .math a[data-mjx-href^="obsidian://"], .math-block a[href^="obsidian://"], .math-block a[data-mjx-href^="obsidian://"], .katex a[href^="obsidian://"], mjx-container a[href^="obsidian://"], mjx-container a[data-mjx-href^="obsidian://"], .MathJax a[href^="obsidian://"], .MathJax a[data-mjx-href^="obsidian://"]`
        );
        if (mathAnchors.length === 0) {
            return;
        }

        let boundCount = 0;
        mathAnchors.forEach((anchor) => {
            const anchorAny = anchor as any;
            if (anchorAny.__glossaryMathLinkBound) {
                return;
            }
            // Prevent double-binding if math-links plugin already bound this anchor
            if (anchor.dataset.mathLinksBound === '1') {
                return;
            }

            const href = anchor.getAttribute('href') ?? '';
            const dataMjxHref = anchor.getAttribute('data-mjx-href') ?? '';
            const dataHref = anchor.getAttribute('data-href') ?? '';
            let resolvedLinkText = dataHref || this.extractFileFromObsidianUrl(href) || this.extractFileFromObsidianUrl(dataMjxHref) || '';
            const placeholderId = href.startsWith(this.glossaryMathPlaceholderPrefix)
                ? href
                : (dataMjxHref.startsWith(this.glossaryMathPlaceholderPrefix) ? dataMjxHref : '');
            if (!resolvedLinkText && placeholderId) {
                const mapped = this.glossaryMathLinkTargets.get(placeholderId);
                if (mapped) {
                    resolvedLinkText = mapped.linkText;
                    anchor.setAttribute('href', mapped.url);
                    if (anchor.hasAttribute('data-mjx-href')) {
                        anchor.setAttribute('data-mjx-href', mapped.url);
                    }
                    this.glossaryMathLinkTargets.delete(placeholderId);
                }
            }

            if (
                !resolvedLinkText ||
                resolvedLinkText.startsWith('MathLinksID_') ||
                resolvedLinkText.startsWith(this.glossaryMathPlaceholderPrefix)
            ) {
                return;
            }

            anchorAny.__glossaryMathLinkBound = true;
            anchor.classList.add('internal-link');
            anchor.classList.add('math-link');
            anchor.setAttribute('data-href', resolvedLinkText);

            anchor.addEventListener('click', (event: MouseEvent) => {
                event.preventDefault();
                event.stopPropagation();
                const openInNewLeaf = event.ctrlKey || event.metaKey;
                const openSourcePath = sourcePath || this.app.workspace.getActiveFile()?.path || '';
                this.app.workspace.openLinkText(resolvedLinkText, openSourcePath, openInNewLeaf);
            });

            anchor.addEventListener('mouseover', (event: MouseEvent) => {
                this.app.workspace.trigger('hover-link', {
                    event,
                    source: 'math-links',
                    hoverParent: root,
                    targetEl: anchor,
                    linktext: resolvedLinkText,
                    sourcePath: sourcePath || this.app.workspace.getActiveFile()?.path || '',
                });
            });

            boundCount += 1;
        });

        if (boundCount > 0) {
            this.logDebug(`Bound ${boundCount} math-link anchors for ${sourcePath}`);
        }
    }

    private extractFileFromObsidianUrl(url: string): string | null {
        if (!url || !url.startsWith('obsidian://')) {
            return null;
        }

        try {
            const parsed = new URL(url);
            const file = parsed.searchParams.get('file');
            return file || null;
        } catch (error) {
            this.logDebug('Failed to parse obsidian:// math link URL', { url, error: String(error) });
            return null;
        }
    }

    private handleGlobalSidebarSwipe(event: WheelEvent): void {
        if (!this.settings.enableSidebarSwipeGesture) {
            return;
        }

        const absX = Math.abs(event.deltaX);
        const absY = Math.abs(event.deltaY);
        const isHorizontalGesture = absX >= 8 && absX > absY * 1.1;

        if (!isHorizontalGesture) {
            // If currently dragging but vertical scroll detected, finalize
            if (this.sidebarSwipeState !== 'idle' && Date.now() - this.lastSidebarSwipeEventAt > 180) {
                this.finishSidebarSwipe();
            }
            return;
        }

        const target = event.target instanceof HTMLElement ? event.target : null;
        const scrollConsumer = this.findHorizontalScrollConsumer(target, event.deltaX);
        if (scrollConsumer) {
            if (this.sidebarSwipeState !== 'idle') {
                this.finishSidebarSwipe();
            }
            return;
        }

        const now = Date.now();
        // If too long since last event, reset
        if (this.sidebarSwipeState !== 'idle' && now - this.lastSidebarSwipeEventAt > 300) {
            this.finishSidebarSwipe();
        }
        this.lastSidebarSwipeEventAt = now;

        const rightSplit = this.getRightSplitElement();
        if (!rightSplit) return;

        const isCollapsed = this.isRightSidebarCollapsed();

        // Start gesture if idle
        if (this.sidebarSwipeState === 'idle') {
            const swipingToOpen = event.deltaX < 0 && isCollapsed;
            const swipingToClose = event.deltaX > 0 && !isCollapsed;

            if (!swipingToOpen && !swipingToClose) return;

            this.sidebarSwipeWasCollapsed = isCollapsed;

            if (swipingToOpen) {
                this.sidebarSwipeProgress = 0;
                // Expand sidebar so its content renders, then offset it off-screen
                this.expandRightSidebarDirect();
                // Force layout so sidebar gets its natural width
                void rightSplit.offsetWidth;
            } else {
                this.sidebarSwipeProgress = 1;
            }

            this.sidebarSwipeState = 'dragging';
            rightSplit.classList.add('glossary-swipe-active');
            // Apply initial transform
            const initialTranslateX = (1 - this.sidebarSwipeProgress) * 100;
            rightSplit.style.transform = `translateX(${initialTranslateX}%)`;
        }

        // Calculate progress change (negative deltaX → swipe left → open → increase progress)
        const sidebarWidth = rightSplit.offsetWidth || 300;
        const progressDelta = -event.deltaX / sidebarWidth;
        this.sidebarSwipeProgress = Math.max(0, Math.min(1, this.sidebarSwipeProgress + progressDelta));

        // Apply transform: progress 0 = translateX(100%), progress 1 = translateX(0%)
        const translateX = (1 - this.sidebarSwipeProgress) * 100;
        rightSplit.style.transform = `translateX(${translateX}%)`;

        event.preventDefault();
        event.stopPropagation();

        // Schedule snap when swipe gesture ends
        if (this.sidebarSwipeEndTimeout) clearTimeout(this.sidebarSwipeEndTimeout);
        this.sidebarSwipeEndTimeout = setTimeout(() => this.finishSidebarSwipe(), 150);
    }

    private finishSidebarSwipe(): void {
        if (this.sidebarSwipeState === 'idle') return;

        if (this.sidebarSwipeEndTimeout) {
            clearTimeout(this.sidebarSwipeEndTimeout);
            this.sidebarSwipeEndTimeout = null;
        }

        const rightSplit = this.getRightSplitElement();
        if (!rightSplit) {
            this.sidebarSwipeState = 'idle';
            this.sidebarSwipeProgress = 0;
            return;
        }

        // Snap open if dragged past 35%, otherwise snap closed
        const shouldBeOpen = this.sidebarSwipeProgress >= 0.35;

        // Animate snap
        rightSplit.classList.remove('glossary-swipe-active');
        rightSplit.classList.add('glossary-swipe-snapping');
        rightSplit.style.transform = shouldBeOpen ? 'translateX(0%)' : 'translateX(100%)';

        const cleanup = () => {
            rightSplit.classList.remove('glossary-swipe-snapping');
            rightSplit.style.transform = '';
            if (!shouldBeOpen) {
                this.collapseRightSidebarDirect();
            }
        };

        const handleTransitionEnd = (e: TransitionEvent) => {
            if (e.propertyName === 'transform') {
                rightSplit.removeEventListener('transitionend', handleTransitionEnd);
                cleanup();
            }
        };
        rightSplit.addEventListener('transitionend', handleTransitionEnd);
        // Fallback timeout in case transitionend doesn't fire
        setTimeout(() => {
            rightSplit.removeEventListener('transitionend', handleTransitionEnd);
            cleanup();
        }, 300);

        this.logDebug('Sidebar swipe finished', {
            progress: this.sidebarSwipeProgress.toFixed(2),
            shouldBeOpen,
            wasCollapsed: this.sidebarSwipeWasCollapsed,
        });

        this.sidebarSwipeState = 'idle';
        this.sidebarSwipeProgress = 0;
    }

    private getRightSplitElement(): HTMLElement | null {
        const rightSplit = (this.app.workspace as any)?.rightSplit;
        if (rightSplit?.containerEl instanceof HTMLElement) {
            return rightSplit.containerEl;
        }
        return document.querySelector('.workspace-split.mod-right-split') as HTMLElement | null;
    }

    private isRightSidebarCollapsed(): boolean {
        const rightSplit = (this.app.workspace as any)?.rightSplit;
        if (!rightSplit) return true;
        if (typeof rightSplit.isCollapsed === 'function') return !!rightSplit.isCollapsed();
        return !!rightSplit.collapsed;
    }

    private expandRightSidebarDirect(): void {
        const rightSplit = (this.app.workspace as any)?.rightSplit;
        if (rightSplit && typeof rightSplit.expand === 'function') {
            rightSplit.expand();
        }
    }

    private collapseRightSidebarDirect(): void {
        const rightSplit = (this.app.workspace as any)?.rightSplit;
        if (rightSplit && typeof rightSplit.collapse === 'function') {
            rightSplit.collapse();
        }
    }

    private findHorizontalScrollConsumer(start: HTMLElement | null, deltaX: number): HTMLElement | null {
        let node: HTMLElement | null = start;
        while (node) {
            if (this.canElementConsumeHorizontalScroll(node, deltaX)) {
                return node;
            }
            node = node.parentElement;
        }
        return null;
    }

    private canElementConsumeHorizontalScroll(element: HTMLElement, deltaX: number): boolean {
        const style = window.getComputedStyle(element);
        const overflowX = style.overflowX;
        const canScrollByStyle = overflowX === 'auto' || overflowX === 'scroll' || overflowX === 'overlay';
        if (!canScrollByStyle) {
            return false;
        }

        const maxScrollLeft = element.scrollWidth - element.clientWidth;
        if (maxScrollLeft <= 1) {
            return false;
        }

        const atStart = element.scrollLeft <= 0;
        const atEnd = element.scrollLeft >= maxScrollLeft - 1;

        if (deltaX > 0) {
            return !atEnd;
        }
        if (deltaX < 0) {
            return !atStart;
        }
        return false;
    }

    private isTruthyFrontmatterValue(value: unknown): boolean {
        if (typeof value === 'boolean') {
            return value;
        }
        if (typeof value === 'number') {
            return value !== 0;
        }
        if (typeof value === 'string') {
            const normalized = value.trim().toLowerCase();
            return normalized === 'true' || normalized === 'yes' || normalized === '1' || normalized === 'on';
        }
        return false;
    }

    private hasFrontmatterProperty(frontmatter: Record<string, unknown> | undefined, propertyName: string): boolean {
        if (!frontmatter || !propertyName) {
            return false;
        }
        return Object.prototype.hasOwnProperty.call(frontmatter, propertyName);
    }

    private shouldBackfillExactMatchProperty(file: TFile, fetcher: LinkerMetaInfoFetcher): boolean {
        const metaInfo = fetcher.getMetaInfo(file);
        if (metaInfo.includeAllFiles) {
            return !metaInfo.isInExcludedDir;
        }
        return metaInfo.includeFile || metaInfo.isInIncludedDir || metaInfo.excludeFile;
    }

    private scheduleExactMatchBackfill(delayMs = 700): void {
        if (this.exactMatchBackfillTimer !== null) {
            window.clearTimeout(this.exactMatchBackfillTimer);
        }
        this.exactMatchBackfillTimer = window.setTimeout(() => {
            this.exactMatchBackfillTimer = null;
            void this.backfillExactMatchPropertyIfNeeded();
        }, delayMs);
    }

    private async backfillExactMatchPropertyIfNeeded(): Promise<void> {
        if (
            (this.settings.exactMatchPropertyBackfillDone && this.settings.antialiasPropertyBackfillDone) ||
            this.exactMatchBackfillRunning
        ) {
            return;
        }

        const exactPropertyName = (this.settings.propertyNameExactMatchOnly ?? '').trim();
        const antialiasPropertyName = (this.settings.propertyNameAntialiases ?? '').trim();
        if (!exactPropertyName && !antialiasPropertyName) {
            this.logDebug('Skipping glossary frontmatter backfill because both property names are empty');
            return;
        }

        this.exactMatchBackfillRunning = true;
        const fetcher = new LinkerMetaInfoFetcher(this.app, this.settings);
        const files = this.app.vault.getMarkdownFiles();

        let eligible = 0;
        let touched = 0;
        let skipped = 0;
        let failed = 0;
        let exactTouched = 0;
        let antialiasTouched = 0;

        this.logDebug('Starting glossary frontmatter backfill', {
            exactPropertyName,
            antialiasPropertyName,
            totalFiles: files.length,
        });

        try {
            for (const file of files) {
                if (!this.shouldBackfillExactMatchProperty(file, fetcher)) {
                    continue;
                }
                eligible += 1;

                const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
                const missingExact = !!exactPropertyName && !this.hasFrontmatterProperty(frontmatter, exactPropertyName);
                const missingAntialiases = !!antialiasPropertyName && !this.hasFrontmatterProperty(frontmatter, antialiasPropertyName);
                if (!missingExact && !missingAntialiases) {
                    skipped += 1;
                    continue;
                }

                try {
                    await this.app.fileManager.processFrontMatter(file, (mutableFrontmatter) => {
                        if (missingExact && exactPropertyName && !Object.prototype.hasOwnProperty.call(mutableFrontmatter, exactPropertyName)) {
                            mutableFrontmatter[exactPropertyName] = false;
                            exactTouched += 1;
                        }
                        if (
                            missingAntialiases &&
                            antialiasPropertyName &&
                            !Object.prototype.hasOwnProperty.call(mutableFrontmatter, antialiasPropertyName)
                        ) {
                            mutableFrontmatter[antialiasPropertyName] = [];
                            antialiasTouched += 1;
                        }
                    });
                    touched += 1;
                } catch (error) {
                    failed += 1;
                    this.logDebug('Failed to write glossary frontmatter defaults for file', {
                        path: file.path,
                        error: String(error),
                    });
                }

                if ((touched + skipped + failed) % 30 === 0) {
                    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
                }
            }

            this.settings.exactMatchPropertyBackfillDone = true;
            this.settings.antialiasPropertyBackfillDone = true;
            await this.saveData(this.settings);
            this.logDebug('Completed glossary frontmatter backfill', {
                exactPropertyName,
                antialiasPropertyName,
                eligible,
                touched,
                skipped,
                failed,
                exactTouched,
                antialiasTouched,
            });
            if (touched > 0) {
                new Notice(
                    `Glossary: initialized frontmatter defaults in ${touched} entries` +
                    (exactTouched > 0 ? ` (${exactPropertyName}: ${exactTouched})` : '') +
                    (antialiasTouched > 0 ? ` (${antialiasPropertyName}: ${antialiasTouched})` : '')
                );
            }
            this.updateManager.update();
        } catch (error) {
            console.error('[Glossary] Frontmatter backfill failed', error);
        } finally {
            this.exactMatchBackfillRunning = false;
        }
    }

    private toggleRightSidebar(): boolean {
        if (this.isRightSidebarCollapsed()) {
            this.expandRightSidebarDirect();
        } else {
            this.collapseRightSidebarDirect();
        }
        return true;
    }

    private logMetadataDiagnosticsForActiveFile(): void {
        const file = this.app.workspace.getActiveFile();
        if (!file) {
            new Notice('No active file for diagnostics');
            return;
        }

        const resolvedOut = this.app.metadataCache.resolvedLinks[file.path] ?? {};
        let inboundCount = 0;
        const inboundFrom: Record<string, number> = {};
        for (const [sourcePath, targets] of Object.entries(this.app.metadataCache.resolvedLinks)) {
            const count = targets[file.path];
            if (typeof count === 'number' && count > 0) {
                inboundFrom[sourcePath] = count;
                inboundCount += count;
            }
        }

        const metadataCacheAny = this.app.metadataCache as any;
        const backlinksRaw = typeof metadataCacheAny.getBacklinksForFile === 'function'
            ? metadataCacheAny.getBacklinksForFile(file)
            : null;

        this.logDebug(`Diagnostics for ${file.path}`, {
            settings: {
                includeVirtualLinksInGraph: this.settings.includeVirtualLinksInGraph,
                includeVirtualLinksInBacklinks: this.settings.includeVirtualLinksInBacklinks,
                virtualLinkMetadataRefreshMs: this.settings.virtualLinkMetadataRefreshMs,
            },
            resolvedOut,
            inboundCount,
            inboundFrom,
            backlinksRaw,
        });

        new Notice('Glossary diagnostics logged to dev console');
    }

    private isPosWithinRange(
        linkFrom: EditorPosition,
        linkTo: EditorPosition,
        selectionFrom: EditorPosition,
        selectionTo: EditorPosition
    ): boolean {
        return (
            (linkFrom.line > selectionFrom.line ||
                (linkFrom.line === selectionFrom.line && linkFrom.ch >= selectionFrom.ch)) &&
            (linkTo.line < selectionTo.line ||
                (linkTo.line === selectionTo.line && linkTo.ch <= selectionTo.ch))
        );
    }

    async activateGlossaryView(): Promise<void> {
        const { workspace } = this.app;

        let leaf: WorkspaceLeaf | null = null;
        const leaves = workspace.getLeavesOfType(GLOSSARY_VIEW_TYPE);

        if (leaves.length > 0) {
            // A leaf with our view already exists, use that
            leaf = leaves[0];
        } else {
            // Create a new leaf in the right sidebar
            leaf = workspace.getRightLeaf(false);
            if (leaf) {
                await leaf.setViewState({ type: GLOSSARY_VIEW_TYPE, active: true });
            }
        }

        // Reveal the leaf in case it is in a collapsed sidebar
        if (leaf) {
            workspace.revealLeaf(leaf);
        }
    }

    addContextMenuItem(menu: Menu, file: TAbstractFile, source: string) {
        // addContextMenuItem(a: any, b: any, c: any) {
        // Capture the MouseEvent when the context menu is triggered   // Define a named function to capture the MouseEvent

        if (!file) {
            return;
        }

        // console.log('Context menu', menu, file, source);

        const that = this;
        const app: App = this.app;
        const updateManager = this.updateManager;
        const settings = this.settings;

        const fetcher = new LinkerMetaInfoFetcher(app, settings);
        // Check, if the file has the linker-included tag

        const isDirectory = app.vault.getAbstractFileByPath(file.path) instanceof TFolder;

        if (!isDirectory) {
            const metaInfo = fetcher.getMetaInfo(file);

            function contextMenuHandler(event: MouseEvent) {
                // Access the element that triggered the context menu
                const targetElement = event.target;

                if (!targetElement || !(targetElement instanceof HTMLElement)) {
                    console.error('No target element');
                    return;
                }

                // Check, if we are clicking on a virtual link inside a note or a note in the file explorer
                const isVirtualLink = targetElement.classList.contains('virtual-link-a');

                const from = parseInt(targetElement.getAttribute('from') || '-1');
                const to = parseInt(targetElement.getAttribute('to') || '-1');

                if (from === -1 || to === -1) {
                    menu.addItem((item) => {
                        // Item to convert a virtual link to a real link
                        item.setTitle(
                            '[Glossary] Converting link is not here.'
                        ).setIcon('link');
                    });
                }
                // Check, if the element has the "virtual-link" class
                else if (isVirtualLink) {
                    menu.addItem((item) => {
                        // Item to convert a virtual link to a real link
                        item.setTitle('[Glossary] Convert to real link')
                            .setIcon('link')
                            .onClick(() => {
                                // Get from and to position from the element
                                const from = parseInt(targetElement.getAttribute('from') || '-1');
                                const to = parseInt(targetElement.getAttribute('to') || '-1');

                                if (from === -1 || to === -1) {
                                    console.error('No from or to position');
                                    return;
                                }

                                // Get the shown text
                                const text = targetElement.getAttribute('origin-text') || '';
                                const target = file;
                                const activeFile = app.workspace.getActiveFile();
                                const activeFilePath = activeFile?.path ?? '';

                                if (!activeFile) {
                                    console.error('No active file');
                                    return;
                                }

                                let absolutePath = target.path;
                                let relativePath =
                                    path.relative(path.dirname(activeFile.path), path.dirname(absolutePath)) +
                                    '/' +
                                    path.basename(absolutePath);
                                relativePath = relativePath.replace(/\\/g, '/'); // Replace backslashes with forward slashes

                                // Problem: we cannot just take the fileToLinktext result, as it depends on the app settings
                                const replacementPath = app.metadataCache.fileToLinktext(target as TFile, activeFilePath);

                                // The last part of the replacement path is the real shortest file name
                                // We have to check, if it leads to the correct file
                                const lastPart = replacementPath.split('/').pop()!;
                                const shortestFile = app.metadataCache.getFirstLinkpathDest(lastPart!, '');
                                // let shortestPath = shortestFile?.path == target.path ? lastPart : replacementPath;
                                let shortestPath = shortestFile?.path == target.path ? lastPart : absolutePath;

                                // Remove superfluous .md extension
                                if (!replacementPath.endsWith('.md')) {
                                    if (absolutePath.endsWith('.md')) {
                                        absolutePath = absolutePath.slice(0, -3);
                                    }
                                    if (shortestPath.endsWith('.md')) {
                                        shortestPath = shortestPath.slice(0, -3);
                                    }
                                    if (relativePath.endsWith('.md')) {
                                        relativePath = relativePath.slice(0, -3);
                                    }
                                }

                                const useMarkdownLinks = settings.useDefaultLinkStyleForConversion
                                    ? settings.defaultUseMarkdownLinks
                                    : settings.useMarkdownLinks;

                                const linkFormat = settings.useDefaultLinkStyleForConversion
                                    ? settings.defaultLinkFormat
                                    : settings.linkFormat;

                                const createLink = (replacementPath: string, text: string, markdownStyle: boolean) => {
                                    if (markdownStyle) {
                                        return `[${text}](${replacementPath})`;
                                    } else {
                                        return `[[${replacementPath}|${text}]]`;
                                    }
                                };

                                // Create the replacement
                                let replacement = '';

                                // If the file is the same as the shown text, and we can use short links, we use them
                                if (replacementPath === text && linkFormat === 'shortest') {
                                    replacement = `[[${replacementPath}]]`;
                                }
                                // Otherwise create a specific link, using the shown text
                                else {
                                    if (linkFormat === 'shortest') {
                                        replacement = createLink(shortestPath, text, useMarkdownLinks);
                                    } else if (linkFormat === 'relative') {
                                        replacement = createLink(relativePath, text, useMarkdownLinks);
                                    } else if (linkFormat === 'absolute') {
                                        replacement = createLink(absolutePath, text, useMarkdownLinks);
                                    }
                                }

                                // Replace the text
                                const editor = app.workspace.getActiveViewOfType(MarkdownView)?.editor;
                                const fromEditorPos = editor?.offsetToPos(from);
                                const toEditorPos = editor?.offsetToPos(to);

                                if (!fromEditorPos || !toEditorPos) {
                                    console.warn('No editor positions');
                                    return;
                                }

                                editor?.replaceRange(replacement, fromEditorPos, toEditorPos);
                            });
                    });
                }

                // Remove the listener to prevent multiple triggers
                document.removeEventListener('contextmenu', contextMenuHandler);
            }

            if (!metaInfo.excludeFile && (metaInfo.includeAllFiles || metaInfo.includeFile || metaInfo.isInIncludedDir)) {
                // Item to exclude a virtual link from the linker
                // This action adds the settings.tagToExcludeFile to the file
                menu.addItem((item) => {
                    item.setTitle('[Glossary] Exclude this file')
                        .setIcon('trash')
                        .onClick(async () => {
                            // Get the shown text
                            const target = file;

                            // Get the file
                            const targetFile = app.vault.getFileByPath(target.path);

                            if (!targetFile) {
                                console.error('No target file');
                                return;
                            }

                            // Add the tag to the file
                            const fileCache = app.metadataCache.getFileCache(targetFile);
                            const frontmatter = fileCache?.frontmatter || {};

                            const tag = settings.tagToExcludeFile;
                            let tags = frontmatter['tags'];

                            if (typeof tags === 'string') {
                                tags = [tags];
                            }

                            if (!Array.isArray(tags)) {
                                tags = [];
                            }

                            if (!tags.includes(tag)) {
                                await app.fileManager.processFrontMatter(targetFile, (frontMatter) => {
                                    if (!frontMatter.tags) {
                                        frontMatter.tags = new Set();
                                    }
                                    const currentTags = [...frontMatter.tags];

                                    frontMatter.tags = new Set([...currentTags, tag]);

                                    // Remove include tag if it exists
                                    const includeTag = settings.tagToIncludeFile;
                                    if (frontMatter.tags.has(includeTag)) {
                                        frontMatter.tags.delete(includeTag);
                                    }
                                });

                                updateManager.update();
                            }
                        });
                });
            } else if (!metaInfo.includeFile && (!metaInfo.includeAllFiles || metaInfo.excludeFile || metaInfo.isInExcludedDir)) {
                //Item to include a virtual link from the linker
                // This action adds the settings.tagToIncludeFile to the file
                menu.addItem((item) => {
                    item.setTitle('[Glossary] Include this file')
                        .setIcon('plus')
                        .onClick(async () => {
                            // Get the shown text
                            const target = file;

                            // Get the file
                            const targetFile = app.vault.getFileByPath(target.path);

                            if (!targetFile) {
                                console.error('No target file');
                                return;
                            }

                            // Add the tag to the file
                            const fileCache = app.metadataCache.getFileCache(targetFile);
                            const frontmatter = fileCache?.frontmatter || {};

                            const tag = settings.tagToIncludeFile;
                            let tags = frontmatter['tags'];

                            if (typeof tags === 'string') {
                                tags = [tags];
                            }

                            if (!Array.isArray(tags)) {
                                tags = [];
                            }

                            if (!tags.includes(tag)) {
                                await app.fileManager.processFrontMatter(targetFile, (frontMatter) => {
                                    if (!frontMatter.tags) {
                                        frontMatter.tags = new Set();
                                    }
                                    const currentTags = [...frontMatter.tags];

                                    frontMatter.tags = new Set([...currentTags, tag]);

                                    // Remove exclude tag if it exists
                                    const excludeTag = settings.tagToExcludeFile;
                                    if (frontMatter.tags.has(excludeTag)) {
                                        frontMatter.tags.delete(excludeTag);
                                    }
                                });

                                updateManager.update();
                            }
                        });
                });
            }

            const currentFrontmatter = app.metadataCache.getFileCache(file as TFile)?.frontmatter;
            const exactProperty = settings.propertyNameExactMatchOnly;
            const exactMatchOnlyEnabled = this.isTruthyFrontmatterValue(currentFrontmatter?.[exactProperty]);

            menu.addItem((item) => {
                item
                    .setTitle(exactMatchOnlyEnabled ? '[Glossary] Disable exact matches only' : '[Glossary] Enable exact matches only')
                    .setIcon(exactMatchOnlyEnabled ? 'list-x' : 'list-checks')
                    .onClick(async () => {
                        const targetFile = app.vault.getFileByPath(file.path);
                        if (!targetFile) {
                            console.error('No target file');
                            return;
                        }

                        await app.fileManager.processFrontMatter(targetFile, (frontMatter) => {
                            if (exactMatchOnlyEnabled) {
                                delete frontMatter[exactProperty];
                            } else {
                                frontMatter[exactProperty] = true;
                            }
                        });

                        updateManager.update();
                    });
            });

            // Capture the MouseEvent when the context menu is triggered
            document.addEventListener('contextmenu', contextMenuHandler, { once: true });
        } else {
            // Check if the directory is in the linker directories
            const path = file.path + '/';
            const isInIncludedDir = fetcher.includeDirPattern.test(path);
            const isInExcludedDir = fetcher.excludeDirPattern.test(path);

            // If the directory is in the linker directories, add the option to exclude it
            if ((fetcher.includeAllFiles && !isInExcludedDir) || isInIncludedDir) {
                menu.addItem((item) => {
                    item.setTitle('[Glossary] Exclude this directory')
                        .setIcon('trash')
                        .onClick(async () => {
                            // Get the shown text
                            const target = file;

                            // Get the file
                            const targetFolder = app.vault.getAbstractFileByPath(target.path) as TFolder;

                            if (!targetFolder) {
                                console.error('No target folder');
                                return;
                            }

                            const newExcludedDirs = Array.from(new Set([...settings.excludedDirectories, targetFolder.name]));
                            const newIncludedDirs = settings.linkerDirectories.filter((dir) => dir !== targetFolder.name);
                            await this.updateSettings({ linkerDirectories: newIncludedDirs, excludedDirectories: newExcludedDirs });

                            updateManager.update();
                        });
                });
            } else if ((!fetcher.includeAllFiles && !isInIncludedDir) || isInExcludedDir) {
                // If the directory is in the excluded directories, add the option to include it
                menu.addItem((item) => {
                    item.setTitle('[Glossary] Include this directory')
                        .setIcon('plus')
                        .onClick(async () => {
                            // Get the shown text
                            const target = file;

                            // Get the file
                            const targetFolder = app.vault.getAbstractFileByPath(target.path) as TFolder;

                            if (!targetFolder) {
                                console.error('No target folder');
                                return;
                            }

                            const newExcludedDirs = settings.excludedDirectories.filter((dir) => dir !== targetFolder.name);
                            const newIncludedDirs = Array.from(new Set([...settings.linkerDirectories, targetFolder.name]));
                            await this.updateSettings({ linkerDirectories: newIncludedDirs, excludedDirectories: newExcludedDirs });

                            updateManager.update();
                        });
                });
            }
        }
    }

    onunload() {
        this.logDebug('Plugin unloading');
        const mathLinksApi = this.getMathLinksApi();
        if (this.didAttachMathLinksApiRewriter && typeof mathLinksApi?.unregisterSourceRewriter === 'function') {
            mathLinksApi.unregisterSourceRewriter(this.mathLinksGlossaryRewriterId);
            this.didAttachMathLinksApiRewriter = false;
        }
        if (this.exactMatchBackfillTimer !== null) {
            window.clearTimeout(this.exactMatchBackfillTimer);
            this.exactMatchBackfillTimer = null;
        }
        this.virtualLinkMetadata?.destroy();
        this.virtualLinkMetadata = null;
        document.body.classList.remove('virtual-linker-hide-frontmatter');
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

        // Load markdown links from obsidian settings
        // At the moment obsidian does not provide a clean way to get the settings through an API
        // So we read the app.json settings file directly
        // We also Cannot use the vault API because it only reads the vault files not the .obsidian folder
        const fileContent = await this.app.vault.adapter.read(this.app.vault.configDir + '/app.json');
        const appSettings = JSON.parse(fileContent);
        this.settings.defaultUseMarkdownLinks = appSettings.useMarkdownLinks;
        this.settings.defaultLinkFormat = appSettings.newLinkFormat ?? 'shortest';
    }

    /** Update plugin settings. */
    async updateSettings(settings: Partial<LinkerPluginSettings> = <Partial<LinkerPluginSettings>>{}) {
        const previousExactPropertyName = this.settings.propertyNameExactMatchOnly;
        const previousAntialiasPropertyName = this.settings.propertyNameAntialiases;
        this.logDebug('Updating settings', settings);
        Object.assign(this.settings, settings);

        const exactPropertyChanged =
            typeof settings.propertyNameExactMatchOnly === 'string' &&
            settings.propertyNameExactMatchOnly !== previousExactPropertyName;
        const antialiasPropertyChanged =
            typeof settings.propertyNameAntialiases === 'string' &&
            settings.propertyNameAntialiases !== previousAntialiasPropertyName;

        if (exactPropertyChanged || antialiasPropertyChanged) {
            if (exactPropertyChanged) {
                this.settings.exactMatchPropertyBackfillDone = false;
            }
            if (antialiasPropertyChanged) {
                this.settings.antialiasPropertyBackfillDone = false;
            }
        }

        await this.saveData(this.settings);
        this.updateManager.update();

        if (exactPropertyChanged || antialiasPropertyChanged) {
            this.scheduleExactMatchBackfill();
        }
    }

    /** Toggle body class for hiding frontmatter in hover preview */
    private updateFrontmatterHidingClass() {
        if (this.settings.hideFrontmatterInHoverPreview) {
            document.body.classList.add('virtual-linker-hide-frontmatter');
        } else {
            document.body.classList.remove('virtual-linker-hide-frontmatter');
        }
    }
}

class LinkerSettingTab extends PluginSettingTab {
    constructor(app: App, public plugin: LinkerPlugin) {
        super(app, plugin);
    }

    display(): void {
        const { containerEl } = this;

        containerEl.empty();

        // Toggle to activate or deactivate the linker
        new Setting(containerEl).setName('Activate Glossary').addToggle((toggle) =>
            toggle.setValue(this.plugin.settings.linkerActivated).onChange(async (value) => {
                // console.log("Linker activated: " + value);
                await this.plugin.updateSettings({ linkerActivated: value });
            })
        );

        // Toggle to show advanced settings
        new Setting(containerEl).setName('Show advanced settings').addToggle((toggle) =>
            toggle.setValue(this.plugin.settings.advancedSettings).onChange(async (value) => {
                // console.log("Advanced settings: " + value);
                await this.plugin.updateSettings({ advancedSettings: value });
                this.display();
            })
        );

        new Setting(containerEl).setName('Matching behavior').setHeading();

        // Toggle to include aliases
        new Setting(containerEl)
            .setName('Include aliases')
            .setDesc('If activated, file aliases will also be used for generating links to glossary entries.')
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.includeAliases).onChange(async (value) => {
                    // console.log("Include aliases: " + value);
                    await this.plugin.updateSettings({ includeAliases: value });
                })
            );

        // Toggle to enable/disable antialiases feature
        new Setting(containerEl)
            .setName('Exclude anti-aliases')
            .setDesc(
                'If enabled, words listed in the antialiases frontmatter property will prevent matches from appearing inside them.'
            )
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.antialiasesEnabled).onChange(async (value) => {
                    await this.plugin.updateSettings({ antialiasesEnabled: value });
                    this.display();
                })
            );

        // Text setting for property name for anti-aliases (only show if enabled)
        if (this.plugin.settings.antialiasesEnabled) {
            new Setting(containerEl)
                .setName('Property name for anti-aliases')
                .setDesc(
                    'Words listed in this frontmatter property define contexts where the term should NOT match.'
                )
                .addText((text) =>
                    text.setValue(this.plugin.settings.propertyNameAntialiases).onChange(async (value) => {
                        await this.plugin.updateSettings({ propertyNameAntialiases: value });
                    })
                );
        }

        new Setting(containerEl)
            .setName('Property name for exact-match-only entries')
            .setDesc(
                'If this frontmatter property is truthy on a glossary note, virtual links for that note are created only for exact full-word matches of title/aliases.'
            )
            .addText((text) =>
                text.setValue(this.plugin.settings.propertyNameExactMatchOnly).onChange(async (value) => {
                    await this.plugin.updateSettings({ propertyNameExactMatchOnly: value });
                })
            );

        if (this.plugin.settings.advancedSettings) {
            // Toggle to only link once
            new Setting(containerEl)
                .setName('Only link once')
                .setDesc('If activated, there will not be several identical virtual links in the same note (Wikipedia style).')
                .addToggle((toggle) =>
                    toggle.setValue(this.plugin.settings.onlyLinkOnce).onChange(async (value) => {
                        // console.log("Only link once: " + value);
                        await this.plugin.updateSettings({ onlyLinkOnce: value });
                    })
                );

            // Toggle to exclude links to real linked files
            new Setting(containerEl)
                .setName('Exclude links to real linked files')
                .setDesc('If activated, there will be no links to files that are already linked in the note by real links.')
                .addToggle((toggle) =>
                    toggle.setValue(this.plugin.settings.excludeLinksToRealLinkedFiles).onChange(async (value) => {
                        // console.log("Exclude links to real linked files: " + value);
                        await this.plugin.updateSettings({ excludeLinksToRealLinkedFiles: value });
                    })
                );
        }

        // If headers should be matched or not
        new Setting(containerEl)
            .setName('Include headers')
            .setDesc('If activated, headers (so your lines beginning with at least one `#`) are included for virtual links.')
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.includeHeaders).onChange(async (value) => {
                    // console.log("Include headers: " + value);
                    await this.plugin.updateSettings({ includeHeaders: value });
                })
            );

        // Toggle setting to match only whole words or any part of the word
        new Setting(containerEl)
            .setName('Match any part of a word')
            .setDesc('If deactivated, only whole words are matched. Otherwise, every part of a word is found.')
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.matchAnyPartsOfWords).onChange(async (value) => {
                    // console.log("Match only whole words: " + value);
                    await this.plugin.updateSettings({ matchAnyPartsOfWords: value });
                    this.display();
                })
            );

        if (!this.plugin.settings.matchAnyPartsOfWords) {
            // Toggle setting to match only beginning of words
            new Setting(containerEl)
                .setName('Match the beginning of words')
                .setDesc('If activated, the beginnings of words are also linked, even if it is not a whole match.')
                .addToggle((toggle) =>
                    toggle.setValue(this.plugin.settings.matchBeginningOfWords).onChange(async (value) => {
                        // console.log("Match only beginning of words: " + value);
                        await this.plugin.updateSettings({ matchBeginningOfWords: value });
                        this.display();
                    })
                );

            // Toggle setting to match only end of words
            new Setting(containerEl)
                .setName('Match the end of words')
                .setDesc('If activated, the ends of words are also linked, even if it is not a whole match.')
                .addToggle((toggle) =>
                    toggle.setValue(this.plugin.settings.matchEndOfWords).onChange(async (value) => {
                        // console.log("Match only end of words: " + value);
                        await this.plugin.updateSettings({ matchEndOfWords: value });
                        this.display();
                    })
                );
        }

        // Toggle setting to suppress suffix for sub words
        if (this.plugin.settings.matchAnyPartsOfWords || this.plugin.settings.matchBeginningOfWords) {
            new Setting(containerEl)
                .setName('Suppress suffix for sub words')
                .setDesc('If activated, the suffix is not added to links for subwords, but only for complete matches.')
                .addToggle((toggle) =>
                    toggle.setValue(this.plugin.settings.suppressSuffixForSubWords).onChange(async (value) => {
                        // console.log("Suppress suffix for sub words: " + value);
                        await this.plugin.updateSettings({ suppressSuffixForSubWords: value });
                    })
                );
        }

        if (this.plugin.settings.advancedSettings) {
            // Toggle setting to exclude links in the current line start for fixing IME
            new Setting(containerEl)
                .setName('Fix IME problem')
                .setDesc(
                    'If activated, there will be no links in the current line start which is followed immediately by the Input Method Editor (IME). This is the recommended setting if you are using IME (input method editor) for typing, e.g. for chinese characters, because instant linking might interfere with IME.'
                )
                .addToggle((toggle) =>
                    toggle.setValue(this.plugin.settings.fixIMEProblem).onChange(async (value) => {
                        // console.log("Exclude links in current line: " + value);
                        await this.plugin.updateSettings({ fixIMEProblem: value });
                    })
                );
        }

        if (this.plugin.settings.advancedSettings) {
            // Toggle setting to exclude links in the current line
            new Setting(containerEl)
                .setName('Avoid linking in current line')
                .setDesc('If activated, there will be no links in the current line.')
                .addToggle((toggle) =>
                    toggle.setValue(this.plugin.settings.excludeLinksInCurrentLine).onChange(async (value) => {
                        // console.log("Exclude links in current line: " + value);
                        await this.plugin.updateSettings({ excludeLinksInCurrentLine: value });
                    })
                );

            // Input for setting the word boundary regex
            // new Setting(containerEl)
            // 	.setName('Word boundary regex')
            // 	.setDesc('The regex for the word boundary. This regex is used to find the beginning and end of a word. It is used to find the boundaries of the words to match. Defaults to /[\t- !-/:-@\[-`{-~\p{Emoji_Presentation}\p{Extended_Pictographic}]/u to catch most word boundaries.')
            // 	.addText((text) =>
            // 		text
            // 			.setValue(this.plugin.settings.wordBoundaryRegex)
            // 			.onChange(async (value) => {
            // 				try {
            // 					await this.plugin.updateSettings({ wordBoundaryRegex: value });
            // 				} catch (e) {
            // 					console.error('Invalid regex', e);
            // 				}
            // 			})
            // 	);
        }



        new Setting(containerEl).setName('Case sensitivity').setHeading();

        // Toggle setting for case sensitivity
        new Setting(containerEl)
            .setName('Case sensitive')
            .setDesc('If activated, the matching is case sensitive.')
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.matchCaseSensitive).onChange(async (value) => {
                    // console.log("Case sensitive: " + value);
                    await this.plugin.updateSettings({ matchCaseSensitive: value });
                    this.display();
                })
            );

        if (this.plugin.settings.advancedSettings) {
            // Number input setting for capital letter proportion for automatic match case
            new Setting(containerEl)
                .setName('Capital letter percentage for automatic match case')
                .setDesc(
                    'The percentage (0 - 100) of capital letters in a file name or alias to be automatically considered as case sensitive.'
                )
                .addText((text) =>
                    text
                        .setValue((this.plugin.settings.capitalLetterProportionForAutomaticMatchCase * 100).toFixed(1))
                        .onChange(async (value) => {
                            let newValue = parseFloat(value);
                            if (isNaN(newValue)) {
                                newValue = 75;
                            } else if (newValue < 0) {
                                newValue = 0;
                            } else if (newValue > 100) {
                                newValue = 100;
                            }
                            newValue /= 100;

                            // console.log("New capital letter proportion for automatic match case: " + newValue);
                            await this.plugin.updateSettings({ capitalLetterProportionForAutomaticMatchCase: newValue });
                        })
                );

            if (this.plugin.settings.matchCaseSensitive) {
                // Text setting for tag to ignore case
                new Setting(containerEl)
                    .setName('Tag to ignore case')
                    .setDesc('By adding this tag to a file, the linker will ignore the case for the file.')
                    .addText((text) =>
                        text.setValue(this.plugin.settings.tagToIgnoreCase).onChange(async (value) => {
                            // console.log("New tag to ignore case: " + value);
                            await this.plugin.updateSettings({ tagToIgnoreCase: value });
                        })
                    );
            } else {
                // Text setting for tag to match case
                new Setting(containerEl)
                    .setName('Tag to match case')
                    .setDesc('By adding this tag to a file, the linker will match the case for the file.')
                    .addText((text) =>
                        text.setValue(this.plugin.settings.tagToMatchCase).onChange(async (value) => {
                            // console.log("New tag to match case: " + value);
                            await this.plugin.updateSettings({ tagToMatchCase: value });
                        })
                    );
            }

            // Text setting for property name to ignore case
            new Setting(containerEl)
                .setName('Property name to ignore case')
                .setDesc(
                    'By adding this property to a note, containing a list of names, the linker will ignore the case for the specified names / aliases. This way you can decide, which alias should be insensitive.'
                )
                .addText((text) =>
                    text.setValue(this.plugin.settings.propertyNameToIgnoreCase).onChange(async (value) => {
                        // console.log("New property name to ignore case: " + value);
                        await this.plugin.updateSettings({ propertyNameToIgnoreCase: value });
                    })
                );

            // Text setting for property name to match case
            new Setting(containerEl)
                .setName('Property name to match case')
                .setDesc(
                    'By adding this property to a note, containing a list of names, the linker will match the case for the specified names / aliases. This way you can decide, which alias should be case sensitive.'
                )
                .addText((text) =>
                    text.setValue(this.plugin.settings.propertyNameToMatchCase).onChange(async (value) => {
                        // console.log("New property name to match case: " + value);
                        await this.plugin.updateSettings({ propertyNameToMatchCase: value });
                    })
                );


        }

        new Setting(containerEl).setName('Matched files').setHeading();

        new Setting(containerEl)
            .setName('Include all files')
            .setDesc('Include all files for the glossary.')
            .addToggle((toggle) =>
                toggle
                    // .setValue(true)
                    .setValue(this.plugin.settings.includeAllFiles)
                    .onChange(async (value) => {
                        // console.log("Include all files: " + value);
                        await this.plugin.updateSettings({ includeAllFiles: value });
                        this.display();
                    })
            );

        if (!this.plugin.settings.includeAllFiles) {
            new Setting(containerEl)
                .setName('Glossary linker directories')
                .setDesc('Directories to include for the glossary (separated by new lines).')
                .addTextArea((text) => {
                    let setValue = '';
                    try {
                        setValue = this.plugin.settings.linkerDirectories.join('\n');
                    } catch (e) {
                        console.warn(e);
                    }

                    text.setPlaceholder('List of directory names (separated by new line)')
                        .setValue(setValue)
                        .onChange(async (value) => {
                            this.plugin.settings.linkerDirectories = value
                                .split('\n')
                                .map((x) => x.trim())
                                .filter((x) => x.length > 0);
                            // console.log("New folder name: " + value, this.plugin.settings.linkerDirectories);
                            await this.plugin.updateSettings();
                        });

                    // Set default size
                    text.inputEl.addClass('linker-settings-text-box');
                });
        } else {
            if (this.plugin.settings.advancedSettings) {
                new Setting(containerEl)
                    .setName('Excluded directories')
                    .setDesc(
                        'Directories from which files are to be excluded for the glossary (separated by new lines). Files in these directories will not create links to glossary entries in other files.'
                    )
                    .addTextArea((text) => {
                        let setValue = '';
                        try {
                            setValue = this.plugin.settings.excludedDirectories.join('\n');
                        } catch (e) {
                            console.warn(e);
                        }

                        text.setPlaceholder('List of directory names (separated by new line)')
                            .setValue(setValue)
                            .onChange(async (value) => {
                                this.plugin.settings.excludedDirectories = value
                                    .split('\n')
                                    .map((x) => x.trim())
                                    .filter((x) => x.length > 0);
                                // console.log("New folder name: " + value, this.plugin.settings.excludedDirectories);
                                await this.plugin.updateSettings();
                            });

                        // Set default size
                        text.inputEl.addClass('linker-settings-text-box');
                    });
            }
        }

        if (this.plugin.settings.advancedSettings) {
            // Text setting for tag to include file
            new Setting(containerEl)
                .setName('Tag to include file')
                .setDesc('Tag to explicitly include the file for the linker.')
                .addText((text) =>
                    text.setValue(this.plugin.settings.tagToIncludeFile).onChange(async (value) => {
                        // console.log("New tag to include file: " + value);
                        await this.plugin.updateSettings({ tagToIncludeFile: value });
                    })
                );

            // Text setting for tag to ignore file
            new Setting(containerEl)
                .setName('Tag to ignore file')
                .setDesc('Tag to ignore the file for the linker.')
                .addText((text) =>
                    text.setValue(this.plugin.settings.tagToExcludeFile).onChange(async (value) => {
                        // console.log("New tag to ignore file: " + value);
                        await this.plugin.updateSettings({ tagToExcludeFile: value });
                    })
                );

            // Toggle setting to exclude links to the active file
            new Setting(containerEl)
                .setName('Exclude self-links to the current note')
                .setDesc('If toggled, links to the note itself are excluded from the linker. (This might not work in preview windows.)')
                .addToggle((toggle) =>
                    toggle.setValue(this.plugin.settings.excludeLinksToOwnNote).onChange(async (value) => {
                        // console.log("Exclude links to active file: " + value);
                        await this.plugin.updateSettings({ excludeLinksToOwnNote: value });
                    })
                );

            // Setting to exclude directories from the linker to be executed
            new Setting(containerEl)
                .setName('Excluded directories for generating virtual links')
                .setDesc('Directories in which the plugin will not create virtual links (separated by new lines).')
                .addTextArea((text) => {
                    let setValue = '';
                    try {
                        setValue = this.plugin.settings.excludedDirectoriesForLinking.join('\n');
                    } catch (e) {
                        console.warn(e);
                    }

                    text.setPlaceholder('List of directory names (separated by new line)')
                        .setValue(setValue)
                        .onChange(async (value) => {
                            this.plugin.settings.excludedDirectoriesForLinking = value
                                .split('\n')
                                .map((x) => x.trim())
                                .filter((x) => x.length > 0);
                            // console.log("New folder name: " + value, this.plugin.settings.excludedDirectoriesForLinking);
                            await this.plugin.updateSettings();
                        });

                    // Set default size
                    text.inputEl.addClass('linker-settings-text-box');
                });
        }

        new Setting(containerEl).setName('Glossary View').setHeading();

        new Setting(containerEl)
            .setName('Open glossary links in sidebar')
            .setDesc('If enabled, clicking a glossary link in the editor (Live Preview or Reading view) will open the entry in the glossary sidebar instead of navigating to the file.')
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.openGlossaryLinksInSidebar).onChange(async (value) => {
                    await this.plugin.updateSettings({ openGlossaryLinksInSidebar: value });
                })
            );

        new Setting(containerEl)
            .setName('Swipe sideways to toggle right sidebar')
            .setDesc('If enabled, horizontal touchpad swipes toggle the right sidebar with reversible step gestures (unless a horizontal scroller can consume the gesture).')
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.enableSidebarSwipeGesture).onChange(async (value) => {
                    await this.plugin.updateSettings({ enableSidebarSwipeGesture: value });
                })
            );

        new Setting(containerEl).setName('Metadata integration').setHeading();

        new Setting(containerEl)
            .setName('Show virtual links in Graph and reference counts')
            .setDesc('Inject virtual links into metadata for Graph view and file reference count calculations.')
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.includeVirtualLinksInGraph).onChange(async (value) => {
                    await this.plugin.updateSettings({ includeVirtualLinksInGraph: value });
                })
            );

        new Setting(containerEl)
            .setName('Show virtual links in Backlinks pane')
            .setDesc('Inject synthetic virtual backlinks into the Backlinks pane for matched terms.')
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.includeVirtualLinksInBacklinks).onChange(async (value) => {
                    await this.plugin.updateSettings({ includeVirtualLinksInBacklinks: value });
                })
            );

        new Setting(containerEl)
            .setName('Metadata refresh interval (ms)')
            .setDesc('Higher values reduce lag spikes by refreshing graph/backlink metadata less frequently.')
            .addText((text) =>
                text
                    .setValue(String(this.plugin.settings.virtualLinkMetadataRefreshMs))
                    .onChange(async (value) => {
                        const parsed = Number(value);
                        if (!Number.isFinite(parsed)) {
                            return;
                        }
                        const clamped = Math.max(500, Math.min(60000, Math.round(parsed)));
                        await this.plugin.updateSettings({ virtualLinkMetadataRefreshMs: clamped });
                    })
            );

        new Setting(containerEl)
            .setName('Verbose debug logging')
            .setDesc('Log detailed glossary integration internals (graph/backlinks/metadata/math/swipe) to the developer console.')
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.debugLogging).onChange(async (value) => {
                    await this.plugin.updateSettings({ debugLogging: value });
                })
            );

        new Setting(containerEl).setName('Link style').setHeading();

        new Setting(containerEl)
            .setName('Always show multiple references')
            .setDesc('If toggled, if there are multiple matching notes, all references are shown behind the match. If not toggled, the references are only shown if hovering over the match.')
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.alwaysShowMultipleReferences).onChange(async (value) => {
                    // console.log("Always show multiple references: " + value);
                    await this.plugin.updateSettings({ alwaysShowMultipleReferences: value });
                })
            );

        new Setting(containerEl)
            .setName('Virtual link suffix')
            .setDesc('The suffix to add to auto generated virtual links.')
            .addText((text) =>
                text.setValue(this.plugin.settings.virtualLinkSuffix).onChange(async (value) => {
                    // console.log("New glossary suffix: " + value);
                    await this.plugin.updateSettings({ virtualLinkSuffix: value });
                })
            );
        new Setting(containerEl)
            .setName('Virtual link suffix for aliases')
            .setDesc('The suffix to add to auto generated virtual links for aliases.')
            .addText((text) =>
                text.setValue(this.plugin.settings.virtualLinkAliasSuffix).onChange(async (value) => {
                    // console.log("New glossary suffix: " + value);
                    await this.plugin.updateSettings({ virtualLinkAliasSuffix: value });
                })
            );

        // Toggle setting to apply default link styling
        new Setting(containerEl)
            .setName('Apply default link styling')
            .setDesc(
                'If toggled, the default link styling will be applied to virtual links. Furthermore, you can style the links yourself with a CSS-snippet affecting the class `virtual-link`. (Find the CSS snippet directory at Appearance -> CSS Snippets -> Open snippets folder)'
            )
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.applyDefaultLinkStyling).onChange(async (value) => {
                    // console.log("Apply default link styling: " + value);
                    await this.plugin.updateSettings({ applyDefaultLinkStyling: value });
                })
            );

        // Toggle setting to hide frontmatter in hover preview
        new Setting(containerEl)
            .setName('Hide frontmatter in hover preview')
            .setDesc(
                'If toggled, the frontmatter (properties/metadata) will be hidden in hover preview popovers when hovering over virtual links.'
            )
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.hideFrontmatterInHoverPreview).onChange(async (value) => {
                    await this.plugin.updateSettings({ hideFrontmatterInHoverPreview: value });
                })
            );

        // Toggle setting to use default link style for conversion
        new Setting(containerEl)
            .setName('Use default link style for conversion')
            .setDesc('If toggled, the default link style will be used for the conversion of virtual links to real links.')
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.useDefaultLinkStyleForConversion).onChange(async (value) => {
                    // console.log("Use default link style for conversion: " + value);
                    await this.plugin.updateSettings({ useDefaultLinkStyleForConversion: value });
                    this.display();
                })
            );

        if (!this.plugin.settings.useDefaultLinkStyleForConversion) {
            // Toggle setting to use markdown links
            new Setting(containerEl)
                .setName('Use [[Wiki-links]]')
                .setDesc('If toggled, the virtual links will be created as wiki-links instead of markdown links.')
                .addToggle((toggle) =>
                    toggle.setValue(!this.plugin.settings.useMarkdownLinks).onChange(async (value) => {
                        // console.log("Use markdown links: " + value);
                        await this.plugin.updateSettings({ useMarkdownLinks: !value });
                    })
                );

            // Dropdown setting for link format
            new Setting(containerEl)
                .setName('Link format')
                .setDesc('The format of the generated links.')
                .addDropdown((dropdown) =>
                    dropdown
                        .addOption('shortest', 'Shortest')
                        .addOption('relative', 'Relative')
                        .addOption('absolute', 'Absolute')
                        .setValue(this.plugin.settings.linkFormat)
                        .onChange(async (value) => {
                            // console.log("New link format: " + value);
                            await this.plugin.updateSettings({ linkFormat: value as 'shortest' | 'relative' | 'absolute' });
                        })
                );
        }

        // AI Settings Section
        new Setting(containerEl).setName('AI-Powered Entry Creation').setHeading();

        new Setting(containerEl)
            .setName('Enable AI entry creation')
            .setDesc('Enable the "Create Glossary Entry with AI" command which generates definitions using an AI model.')
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.aiEnabled).onChange(async (value) => {
                    await this.plugin.updateSettings({ aiEnabled: value });
                    this.display();
                })
            );

        if (this.plugin.settings.aiEnabled) {
            // Provider selection dropdown
            new Setting(containerEl)
                .setName('AI Provider')
                .setDesc('Select your AI provider.')
                .addDropdown((dropdown) => {
                    AI_PROVIDER_PRESETS.forEach(preset => {
                        dropdown.addOption(preset.id, preset.name);
                    });
                    dropdown
                        .setValue(this.plugin.settings.aiActiveProvider)
                        .onChange(async (value) => {
                            await this.plugin.updateSettings({ aiActiveProvider: value });
                            this.display();
                        });
                });

            const activePreset = AI_PROVIDER_PRESETS.find(p => p.id === this.plugin.settings.aiActiveProvider);
            const savedProvider = this.plugin.settings.aiProviders.find(p => p.id === this.plugin.settings.aiActiveProvider);
            const currentConfig = savedProvider || (activePreset ? { ...activePreset, apiKey: '' } : null);

            if (currentConfig) {
                // Endpoint (editable for custom, readonly for presets)
                new Setting(containerEl)
                    .setName('API Endpoint')
                    .setDesc('The API endpoint URL.')
                    .addText((text) => {
                        text
                            .setPlaceholder('https://api.example.com/v1/chat/completions')
                            .setValue(currentConfig.endpoint)
                            .onChange(async (value) => {
                                await this.updateProviderConfig({ endpoint: value });
                            });
                        if (this.plugin.settings.aiActiveProvider !== 'custom') {
                            text.inputEl.style.opacity = '0.7';
                        }
                    });

                // API Key
                new Setting(containerEl)
                    .setName('API Key')
                    .setDesc('Your API key for authentication.')
                    .addText((text) => {
                        text
                            .setPlaceholder('sk-... or your API key')
                            .setValue(currentConfig.apiKey)
                            .onChange(async (value) => {
                                await this.updateProviderConfig({ apiKey: value });
                            });
                        text.inputEl.type = 'password';
                    });

                // Model with fetch button
                const modelSetting = new Setting(containerEl)
                    .setName('Model')
                    .setDesc('The AI model to use. Click "Fetch" to load available models.');

                let modelDropdown: any = null;
                let modelInput: any = null;

                modelSetting.addText((text) => {
                    modelInput = text;
                    text
                        .setPlaceholder('gpt-4o-mini')
                        .setValue(currentConfig.model)
                        .onChange(async (value) => {
                            await this.updateProviderConfig({ model: value });
                        });
                });

                modelSetting.addButton((button) => {
                    button
                        .setButtonText('Fetch Models')
                        .onClick(async () => {
                            button.setButtonText('Loading...');
                            button.setDisabled(true);

                            const aiCreator = new AIEntryCreator(this.plugin.app, this.plugin.settings);
                            const result = await aiCreator.fetchModels();

                            if (result.success && result.models && result.models.length > 0) {
                                // Show dropdown with models
                                const modal = new ModelSelectModal(this.plugin.app, result.models, currentConfig.model, async (selected) => {
                                    await this.updateProviderConfig({ model: selected });
                                    if (modelInput) {
                                        modelInput.setValue(selected);
                                    }
                                });
                                modal.open();
                            } else {
                                new Notice(result.error || 'No models found');
                            }

                            button.setButtonText('Fetch Models');
                            button.setDisabled(false);
                        });
                });

                new Setting(containerEl)
                    .setName('Max Output Tokens')
                    .setDesc('Maximum number of tokens for the AI response. Increase this for models that do extended thinking (e.g. Gemini 3 Pro).')
                    .addText((text) =>
                        text
                            .setValue(String(this.plugin.settings.aiMaxTokens))
                            .onChange(async (value) => {
                                const num = parseInt(value);
                                if (!isNaN(num) && num > 0) {
                                    await this.plugin.updateSettings({ aiMaxTokens: num });
                                }
                            })
                    );
            }

            new Setting(containerEl)
                .setName('System Prompt')
                .setDesc('The system prompt used for generating definitions. Uses {{ALLOWED_LANGUAGES}} and {{FALLBACK_LANGUAGE}} variables.')
                .addTextArea((text) => {
                    text
                        .setPlaceholder('Enter system prompt...')
                        .setValue(this.plugin.settings.aiSystemPrompt)
                        .onChange(async (value) => {
                            await this.plugin.updateSettings({ aiSystemPrompt: value });
                        });
                    text.inputEl.rows = 6;
                    text.inputEl.style.width = '100%';
                    text.inputEl.style.minHeight = '150px';
                    text.inputEl.classList.add('linker-settings-text-box');
                })
                .addExtraButton((btn) =>
                    btn
                        .setIcon('rotate-ccw')
                        .setTooltip('Reset to default')
                        .onClick(async () => {
                            await this.plugin.updateSettings({ aiSystemPrompt: DEFAULT_SETTINGS.aiSystemPrompt });
                            this.display();
                        })
                );

            // Metadata Generation Section
            new Setting(containerEl).setName('Metadata Generation (Optional)').setHeading();

            new Setting(containerEl)
                .setName('Generate separate metadata')
                .setDesc('Use a potentially different model request to generate title and aliases.')
                .addToggle((toggle) =>
                    toggle.setValue(this.plugin.settings.aiGenerateMetadata).onChange(async (value) => {
                        await this.plugin.updateSettings({ aiGenerateMetadata: value });
                        this.display();
                    })
                );

            if (this.plugin.settings.aiGenerateMetadata) {
                new Setting(containerEl)
                    .setName('Metadata Model')
                    .setDesc('Model ID to use for metadata (e.g. "gemini-2.0-flash", "gpt-4o-mini"). Leave empty to use the main provider model.')
                    .addText((text) =>
                        text
                            .setPlaceholder('Same as main model')
                            .setValue(this.plugin.settings.aiMetadataModel)
                            .onChange(async (value) => {
                                await this.plugin.updateSettings({ aiMetadataModel: value });
                            })
                    );

                new Setting(containerEl)
                    .setName('Metadata System Prompt')
                    .setDesc('Prompt for generating JSON metadata. Uses {{ALLOWED_LANGUAGES}} and {{FALLBACK_LANGUAGE}} variables.')
                    .addTextArea((text) => {
                        text
                            .setValue(this.plugin.settings.aiMetadataSystemPrompt)
                            .onChange(async (value) => {
                                await this.plugin.updateSettings({ aiMetadataSystemPrompt: value });
                            });
                        text.inputEl.rows = 6;
                        text.inputEl.style.width = '100%';
                    })
                    .addExtraButton((btn) =>
                        btn
                            .setIcon('rotate-ccw')
                            .setTooltip('Reset to default')
                            .onClick(async () => {
                                await this.plugin.updateSettings({ aiMetadataSystemPrompt: DEFAULT_SETTINGS.aiMetadataSystemPrompt });
                                this.display();
                            })
                    );
            }

            // Language Variables Section
            new Setting(containerEl).setName('Prompt Variables').setHeading();

            new Setting(containerEl)
                .setName('Allowed Languages')
                .setDesc('Comma-separated list of languages the AI can output in. Used in {{ALLOWED_LANGUAGES}} placeholder.')
                .addText((text) =>
                    text
                        .setPlaceholder('English, German, Spanish')
                        .setValue(this.plugin.settings.aiAllowedLanguages)
                        .onChange(async (value) => {
                            await this.plugin.updateSettings({ aiAllowedLanguages: value });
                        })
                );

            new Setting(containerEl)
                .setName('Fallback Language')
                .setDesc("Default language if the term's language is not in the allowed list. Used in {{FALLBACK_LANGUAGE}}.")
                .addText((text) =>
                    text
                        .setPlaceholder('English')
                        .setValue(this.plugin.settings.aiFallbackLanguage)
                        .onChange(async (value) => {
                            await this.plugin.updateSettings({ aiFallbackLanguage: value });
                        })
                );
        }
    }

    /**
     * Update the current provider configuration
     */
    private async updateProviderConfig(updates: Partial<AIProviderConfig>) {
        const providerId = this.plugin.settings.aiActiveProvider;
        const providers = [...this.plugin.settings.aiProviders];
        const existingIndex = providers.findIndex(p => p.id === providerId);

        const preset = AI_PROVIDER_PRESETS.find(p => p.id === providerId);
        const base = existingIndex >= 0 ? providers[existingIndex] : (preset ? { ...preset, apiKey: '' } : null);

        if (!base) return;

        const updated = { ...base, ...updates };

        if (existingIndex >= 0) {
            providers[existingIndex] = updated;
        } else {
            providers.push(updated);
        }

        await this.plugin.updateSettings({ aiProviders: providers });
    }
}

// Simple modal for model selection
class ModelSelectModal extends Modal {
    constructor(
        app: App,
        private models: string[],
        private currentModel: string,
        private onSelect: (model: string) => void
    ) {
        super(app);
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h2', { text: 'Select Model' });

        const searchInput = contentEl.createEl('input', {
            type: 'text',
            placeholder: 'Search models...',
            cls: 'linker-model-search'
        });
        searchInput.style.width = '100%';
        searchInput.style.marginBottom = '10px';
        searchInput.style.padding = '8px';

        const listContainer = contentEl.createDiv({ cls: 'linker-model-list' });
        listContainer.style.maxHeight = '300px';
        listContainer.style.overflowY = 'auto';

        const renderList = (filter: string) => {
            listContainer.empty();
            const filtered = this.models.filter(m => m.toLowerCase().includes(filter.toLowerCase()));

            filtered.forEach(model => {
                const item = listContainer.createDiv({ cls: 'linker-model-item' });
                item.style.padding = '8px';
                item.style.cursor = 'pointer';
                item.style.borderRadius = '4px';
                if (model === this.currentModel) {
                    item.style.backgroundColor = 'var(--interactive-accent)';
                    item.style.color = 'var(--text-on-accent)';
                }
                item.textContent = model;

                item.addEventListener('click', () => {
                    this.onSelect(model);
                    this.close();
                });

                item.addEventListener('mouseenter', () => {
                    if (model !== this.currentModel) {
                        item.style.backgroundColor = 'var(--background-modifier-hover)';
                    }
                });
                item.addEventListener('mouseleave', () => {
                    if (model !== this.currentModel) {
                        item.style.backgroundColor = '';
                    }
                });
            });
        };

        renderList('');
        searchInput.addEventListener('input', () => renderList(searchInput.value));
        searchInput.focus();
    }

    onClose() {
        this.contentEl.empty();
    }
}

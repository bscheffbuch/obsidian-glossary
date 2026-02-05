import { App, EditorPosition, MarkdownView, Menu, Modal, Notice, Plugin, PluginSettingTab, Setting, TAbstractFile, TFile, TFolder, WorkspaceLeaf } from 'obsidian';

import { GlossaryLinker } from './linker/readModeLinker';
import { liveLinkerPlugin } from './linker/liveLinker';
import { ExternalUpdateManager, LinkerCache } from 'linker/linkerCache';
import { LinkerMetaInfoFetcher } from 'linker/linkerInfo';
import { GlossaryView, GLOSSARY_VIEW_TYPE } from './linker/GlossaryView';
import { AIEntryCreator } from './linker/aiEntryCreator';

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

Language: Match the input term's language if in [{{ALLOWED_LANGUAGES}}], else use {{FALLBACK_LANGUAGE}}.

Return ONLY valid JSON. No markdown code blocks. No explanation. Example:
{"title": "Term", "aliases": ["alt1", "alt2"], "tags": ["glossary", "topic"]}`,
    aiAllowedLanguages: 'English, German',
    aiFallbackLanguage: 'English',

    // wordBoundaryRegex: '/[\\t- !-/:-@\\[-`{-~\\p{Emoji_Presentation}\\p{Extended_Pictographic}]/u',
};

export default class LinkerPlugin extends Plugin {
    settings: LinkerPluginSettings;
    updateManager = new ExternalUpdateManager();

    async onload() {
        await this.loadSettings();

        // Apply body class for conditional CSS (hide frontmatter in hover preview)
        this.updateFrontmatterHidingClass();

        // Set callback to update the cache when the settings are changed
        this.updateManager.registerCallback(() => {
            LinkerCache.getInstance(this.app, this.settings).clearCache();
            this.updateFrontmatterHidingClass();
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

        // Register antialiases as a known property type with icon
        // @ts-ignore - metadataTypeManager is internal API
        if (this.app.metadataTypeManager) {
            // @ts-ignore
            this.app.metadataTypeManager.setType(this.settings.propertyNameAntialiases, 'multitext');
            // Register a property info for rendering
            // @ts-ignore
            if (this.app.metadataTypeManager.properties) {
                // @ts-ignore
                this.app.metadataTypeManager.properties[this.settings.propertyNameAntialiases] = {
                    name: this.settings.propertyNameAntialiases,
                    type: 'multitext'
                };
            }
        }

        // Register the glossary linker for the read mode
        this.registerMarkdownPostProcessor((element, context) => {
            context.addChild(new GlossaryLinker(this.app, this.settings, context, element));
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

        this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
            if (file instanceof TFile && file.extension === 'md') {
                LinkerCache.getInstance(this.app, this.settings).clearCache();
                this.updateManager.update();
            }
        }));

        this.registerEvent(this.app.metadataCache.on('changed', (file) => {
            // Triggered when file metadata (frontmatter/aliases) changes
            LinkerCache.getInstance(this.app, this.settings).clearCache();
            this.updateManager.update();
        }));

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

    onunload() { }

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
        Object.assign(this.settings, settings);
        await this.saveData(this.settings);
        this.updateManager.update();
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

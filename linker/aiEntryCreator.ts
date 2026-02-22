import { App, Notice, TFile, normalizePath, MarkdownRenderer, Component } from 'obsidian';
import { LinkerPluginSettings } from '../main';

const HUB_PLUGIN_ID = 'ai-provider-hub';
const DEFAULT_DEFINITION_MODEL_USE_ID = 'glossary.ai.definition';
const DEFAULT_METADATA_MODEL_USE_ID = 'glossary.ai.metadata';

interface HubModelSelection {
    modelTypeId: string;
    model: string;
    modelKey?: string;
    modelUseId?: string;
}

interface HubModelCatalogItem {
    key: string;
    modelTypeId: string;
    modelTypeDisplayName: string;
    model: string;
}

interface HubRequestOptions {
    selection?: Partial<HubModelSelection>;
}

interface HubResponse<TData = unknown> {
    data: TData;
}

interface AiProviderHubApi {
    getModelSelectionForUse: (modelUseId: string) => HubModelCatalogItem | null;
    chatCompletions: <TData = unknown>(
        payload: Record<string, unknown>,
        options?: HubRequestOptions
    ) => Promise<HubResponse<TData>>;
}

interface AiProviderHubRuntime {
    getApi?: () => AiProviderHubApi;
    api?: AiProviderHubApi;
}

export interface AIGenerationResult {
    success: boolean;
    definition?: string;
    error?: string;
}

interface CreateEntryFromSelectionOptions {
    onDefinitionComplete?: () => void;
}

interface GlossaryMetadata {
    title?: string;
    aliases?: string[];
    antialiases?: string[];
    exactMatchOnly?: boolean;
}

/**
 * Floating preview panel for streaming AI responses
 */
class StreamingPreview {
    private containerEl: HTMLElement | null = null;
    private contentEl: HTMLElement | null = null;
    private isHovered = false;
    private fadeTimeout: number | null = null;
    private component: Component;
    private isVisible = false;
    private generationDone = false;

    constructor(private app: App) {
        this.component = new Component();
    }

    private createElements() {
        if (this.containerEl) return;

        this.containerEl = document.body.createDiv({ cls: 'ai-streaming-preview' });
        this.contentEl = this.containerEl.createDiv({ cls: 'ai-streaming-content' });

        Object.assign(this.containerEl.style, {
            position: 'fixed',
            top: '50px', // Top right, leaving space for window controls
            right: '20px',
            maxWidth: '400px',
            maxHeight: '300px',
            backgroundColor: 'var(--background-primary)',
            border: '1px solid var(--background-modifier-border)',
            borderRadius: '8px',
            boxShadow: '0 4px 20px rgba(0,0,0,0.2)',
            padding: '12px',
            zIndex: '1000',
            overflow: 'auto',
            opacity: '0',
            transition: 'opacity 0.3s ease-in-out',
            display: 'none',
        });

        Object.assign(this.contentEl.style, {
            fontSize: '14px',
            lineHeight: '1.5',
        });

        // Subtle close button
        const closeBtn = this.containerEl.createEl('span', { text: '×' });
        Object.assign(closeBtn.style, {
            position: 'absolute',
            top: '6px',
            right: '10px',
            fontSize: '14px',
            cursor: 'pointer',
            color: 'var(--text-faint)',
            opacity: '0.5',
            lineHeight: '1',
        });
        closeBtn.onmouseenter = () => closeBtn.style.opacity = '1';
        closeBtn.onmouseleave = () => closeBtn.style.opacity = '0.5';
        closeBtn.onclick = () => this.hide();

        this.containerEl.addEventListener('mouseenter', () => {
            this.isHovered = true;
            if (this.fadeTimeout) {
                window.clearTimeout(this.fadeTimeout);
                this.fadeTimeout = null;
            }
        });

        this.containerEl.addEventListener('mouseleave', () => {
            this.isHovered = false;
            if (this.generationDone) {
                this.startFadeTimer();
            }
        });
    }

    show() {
        this.createElements();
        if (!this.containerEl) return;
        this.containerEl.style.display = 'block';
        requestAnimationFrame(() => {
            if (this.containerEl) {
                this.containerEl.style.opacity = '1';
            }
        });
        this.isVisible = true;
    }

    async updateContent(text: string) {
        if (!this.isVisible && text.trim()) {
            this.show();
        }
        if (!this.contentEl) return;
        this.contentEl.empty();

        // Strip frontmatter for preview
        let previewText = text;
        const frontmatterRegex = /^---\s*[\s\S]*?---\s*/;
        previewText = previewText.replace(frontmatterRegex, '').trim();

        await MarkdownRenderer.render(this.app, previewText, this.contentEl, '', this.component);
    }

    private startFadeTimer() {
        if (this.fadeTimeout) {
            window.clearTimeout(this.fadeTimeout);
        }
        this.fadeTimeout = window.setTimeout(() => {
            if (!this.isHovered) {
                this.hide();
            }
        }, 5000);
    }

    finishGeneration(success: boolean) {
        this.generationDone = true;
        if (!this.isHovered) {
            this.startFadeTimer();
        }
    }

    hide() {
        if (!this.containerEl) return;
        this.containerEl.style.opacity = '0';
        setTimeout(() => {
            if (this.containerEl) {
                this.containerEl.remove();
                this.containerEl = null;
            }
            this.component.unload();
        }, 300);
        this.isVisible = false;
    }
}

export class AIEntryCreator {
    constructor(
        private app: App,
        private settings: LinkerPluginSettings
    ) { }

    /**
     * Substitute prompt variables with actual values from settings
     */
    private substitutePromptVariables(prompt: string): string {
        return prompt
            .replace(/\{\{ALLOWED_LANGUAGES\}\}/g, this.settings.aiAllowedLanguages || 'English')
            .replace(/\{\{FALLBACK_LANGUAGE\}\}/g, this.settings.aiFallbackLanguage || 'English');
    }

    /**
     * Get the effective system prompt - merged or definition-only depending on settings
     */
    private getEffectiveSystemPrompt(): string {
        const definitionPrompt = this.substitutePromptVariables(this.settings.aiSystemPrompt);
        const exactPropertyName = this.settings.propertyNameExactMatchOnly || 'linker-exact-match-only';
        const antialiasPropertyName = this.settings.propertyNameAntialiases || 'antialiases';
        const frontmatterInstruction =
            `When YAML frontmatter is requested, include "${exactPropertyName}: false" by default (set true only for strict matching) ` +
            `and include "${antialiasPropertyName}: []" by default.`;

        if (this.settings.aiGenerateMetadata) {
            // Separate metadata generation - definition prompt only (no frontmatter)
            return definitionPrompt;
        } else {
            // Single request - merge metadata prompt with definition prompt
            const metadataPrompt = this.substitutePromptVariables(this.settings.aiMetadataSystemPrompt);
            return `${metadataPrompt}\n\n---\n\n${definitionPrompt}\n\nIMPORTANT: Include YAML frontmatter (with --- delimiters) at the start of your response, followed by the definition content.\n${frontmatterInstruction}`;
        }
    }

    private parseBooleanLike(value: unknown): boolean | undefined {
        if (typeof value === 'boolean') {
            return value;
        }
        if (typeof value === 'number') {
            return value !== 0;
        }
        if (typeof value === 'string') {
            const normalized = value.trim().toLowerCase();
            if (normalized === 'true' || normalized === 'yes' || normalized === '1' || normalized === 'on') {
                return true;
            }
            if (normalized === 'false' || normalized === 'no' || normalized === '0' || normalized === 'off') {
                return false;
            }
        }
        return undefined;
    }

    private escapeRegExp(input: string): string {
        return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    /**
     * Properly quote a string for YAML frontmatter.
     * Uses single quotes and doubles internal single quotes if the value
     * contains backslashes, colons, or other YAML-special characters.
     */
    private yamlQuote(value: string): string {
        // If the value contains backslashes, colons, quotes, or braces, use single-quoted scalar
        if (/[\\:"'{}\[\]#|>&*!%@`]/.test(value)) {
            // YAML single-quoted scalar: escape internal ' by doubling
            return `'${value.replace(/'/g, "''")}'`;
        }
        return `"${value}"`;
    }

    /**
     * Strip LaTeX commands to produce a plain-text version for use in filenames.
     * E.g. \text{ATP}_\text{int} → ATP int
     */
    private stripLatexForFilename(text: string): string {
        let out = text;
        // Iteratively unwrap LaTeX commands: \text{ATP} → ATP
        let prev = '';
        while (prev !== out) {
            prev = out;
            out = out.replace(/\\[a-zA-Z]+\*?\{([^{}]*)\}/g, '$1');
        }
        // Remove remaining backslash commands without braces
        out = out.replace(/\\[a-zA-Z]+\*?/g, '');
        // Remove leftover braces
        out = out.replace(/[{}]/g, '');
        // Replace sub/superscript markers with spaces
        out = out.replace(/[_^]/g, ' ');
        // Clean up whitespace and dollar signs
        out = out.replace(/\$/g, '').replace(/\s+/g, ' ').trim();
        return out || text;
    }

    private isRecord(value: unknown): value is Record<string, unknown> {
        return typeof value === 'object' && value !== null && !Array.isArray(value);
    }

    private stringifyMessageContent(content: unknown): string {
        if (typeof content === 'string') {
            return content;
        }

        if (Array.isArray(content)) {
            return content
                .map((item) => {
                    if (typeof item === 'string') {
                        return item;
                    }
                    if (this.isRecord(item) && typeof item.text === 'string') {
                        return item.text;
                    }
                    return '';
                })
                .join('\n')
                .trim();
        }

        if (this.isRecord(content) && typeof content.text === 'string') {
            return content.text;
        }

        return '';
    }

    private extractTextFromResponse(data: unknown): string {
        if (typeof data === 'string') {
            return data;
        }

        if (!this.isRecord(data)) {
            return '';
        }

        if (typeof data.output_text === 'string') {
            return data.output_text;
        }

        const responseOutput = data.output;
        if (Array.isArray(responseOutput)) {
            const outputText = responseOutput
                .map((outputItem) => {
                    if (!this.isRecord(outputItem)) {
                        return '';
                    }

                    if (typeof outputItem.text === 'string') {
                        return outputItem.text;
                    }

                    const content = outputItem.content;
                    if (Array.isArray(content)) {
                        return content
                            .map((contentItem) => {
                                if (!this.isRecord(contentItem)) {
                                    return '';
                                }
                                if (typeof contentItem.text === 'string') {
                                    return contentItem.text;
                                }
                                return '';
                            })
                            .join('\n');
                    }

                    return '';
                })
                .join('\n')
                .trim();

            if (outputText) {
                return outputText;
            }
        }

        const choices = data.choices;
        if (Array.isArray(choices) && choices.length > 0 && this.isRecord(choices[0])) {
            const choice = choices[0];

            if (typeof choice.text === 'string') {
                return choice.text;
            }

            if (typeof choice.content === 'string') {
                return choice.content;
            }

            if (this.isRecord(choice.message)) {
                const messageText = this.stringifyMessageContent(choice.message.content);
                if (messageText) {
                    return messageText;
                }
            }

            if (this.isRecord(choice.delta)) {
                const deltaText = this.stringifyMessageContent(choice.delta.content);
                if (deltaText) {
                    return deltaText;
                }
            }
        }

        const content = data.content;
        const contentText = this.stringifyMessageContent(content);
        if (contentText) {
            return contentText;
        }

        return '';
    }

    private getHubApi(notifyIfMissing = false): AiProviderHubApi | null {
        const pluginManager = (this.app as App & {
            plugins?: { getPlugin: (id: string) => unknown };
        }).plugins;

        const plugin = (pluginManager?.getPlugin(HUB_PLUGIN_ID) ?? null) as AiProviderHubRuntime | null;
        if (!plugin) {
            if (notifyIfMissing) {
                new Notice('AI Provider Hub is not enabled. Enable the ai-provider-hub addon first.');
            }
            return null;
        }

        const api = plugin.getApi?.() ?? plugin.api;
        if (!api && notifyIfMissing) {
            new Notice('AI Provider Hub API is unavailable. Update or reload the ai-provider-hub addon.');
        }
        return api ?? null;
    }

    private getDefinitionModelUseId(): string {
        return this.settings.aiDefinitionModelUseId?.trim() || DEFAULT_DEFINITION_MODEL_USE_ID;
    }

    private getMetadataModelUseId(): string {
        return this.settings.aiMetadataModelUseId?.trim() || DEFAULT_METADATA_MODEL_USE_ID;
    }

    private parseModelKey(modelKey: string): { modelTypeId: string; model: string } | null {
        const trimmed = modelKey.trim();
        const separator = trimmed.indexOf('::');
        if (separator <= 0) {
            return null;
        }
        const modelTypeId = trimmed.slice(0, separator).trim();
        const model = trimmed.slice(separator + 2).trim();
        if (!modelTypeId || !model) {
            return null;
        }
        return { modelTypeId, model };
    }

    private resolveMetadataSelection(api: AiProviderHubApi): Partial<HubModelSelection> {
        const modelUseId = this.getMetadataModelUseId();
        const definitionModelUseId = this.getDefinitionModelUseId();
        const override = this.settings.aiMetadataModel?.trim();
        const metadataSelection = api.getModelSelectionForUse(modelUseId);
        const definitionSelection = api.getModelSelectionForUse(definitionModelUseId);

        if (!override) {
            if (metadataSelection) {
                return { modelUseId };
            }
            return { modelUseId: definitionModelUseId };
        }

        const parsedOverride = this.parseModelKey(override);
        if (parsedOverride) {
            return {
                modelTypeId: parsedOverride.modelTypeId,
                model: parsedOverride.model,
                modelKey: override,
            };
        }

        if (metadataSelection) {
            return {
                modelTypeId: metadataSelection.modelTypeId,
                model: override,
            };
        }

        if (definitionSelection) {
            return {
                modelTypeId: definitionSelection.modelTypeId,
                model: override,
            };
        }

        return { modelUseId: definitionModelUseId };
    }

    async generateDefinitionStreaming(term: string, context: string): Promise<AIGenerationResult> {
        if (!this.settings.aiEnabled) return { success: false, error: 'AI generation is not enabled' };
        const api = this.getHubApi(true);
        if (!api) return { success: false, error: 'AI Provider Hub is unavailable' };

        const languages = this.settings.aiAllowedLanguages || 'English';
        const fallback = this.settings.aiFallbackLanguage || 'English';
        const userPrompt = `Term: "${term}"

Context where the term appears:
"${context}"

Language settings: Allowed languages are [${languages}]. If the term is not in one of these languages, use ${fallback}.`;
        const preview = new StreamingPreview(this.app);

        const statusEl = document.body.querySelector('.status-bar')?.createDiv({ cls: 'status-bar-item ai-status' });
        statusEl?.setText('AI generating...');

        try {
            const response = await api.chatCompletions<unknown>(
                {
                    messages: [
                        { role: 'system', content: this.getEffectiveSystemPrompt() },
                        { role: 'user', content: userPrompt }
                    ],
                    temperature: 0.7,
                    max_tokens: this.settings.aiMaxTokens,
                },
                {
                    selection: {
                        modelUseId: this.getDefinitionModelUseId(),
                    },
                }
            );

            const fullContent = this.extractTextFromResponse(response.data).trim();
            if (!fullContent) {
                preview.finishGeneration(false);
                return { success: false, error: 'No response from AI model.' };
            }

            await preview.updateContent(fullContent);
            preview.finishGeneration(true);
            return { success: true, definition: fullContent };
        } catch (error) {
            console.error('[AI Error]', error);
            preview.finishGeneration(false);
            return { success: false, error: `Request failed: ${error instanceof Error ? error.message : String(error)}` };
        } finally {
            statusEl?.remove();
        }
    }

    async generateDefinition(term: string, context: string): Promise<AIGenerationResult> {
        if (!this.settings.aiEnabled) return { success: false, error: 'AI generation is not enabled' };
        const api = this.getHubApi(true);
        if (!api) return { success: false, error: 'AI Provider Hub is unavailable' };

        const userPrompt = `Term: "${term}"\n\nContext where the term appears:\n"${context}"`;

        try {
            const response = await api.chatCompletions<unknown>(
                {
                    messages: [
                        { role: 'system', content: this.getEffectiveSystemPrompt() },
                        { role: 'user', content: userPrompt }
                    ],
                    temperature: 0.7,
                    max_tokens: this.settings.aiMaxTokens,
                },
                {
                    selection: {
                        modelUseId: this.getDefinitionModelUseId(),
                    },
                }
            );

            const definition = this.extractTextFromResponse(response.data).trim();
            if (!definition) {
                return { success: false, error: 'No response from AI model.' };
            }
            return { success: true, definition };
        } catch (error) {
            console.error('[AI Error]', error);
            return { success: false, error: `Request failed: ${error instanceof Error ? error.message : String(error)}` };
        }
    }

    async generateMetadata(term: string, context: string): Promise<GlossaryMetadata | null> {
        if (!this.settings.aiEnabled || !this.settings.aiGenerateMetadata) return null;

        const api = this.getHubApi(true);
        if (!api) return null;

        const systemPrompt = this.substitutePromptVariables(this.settings.aiMetadataSystemPrompt);
        const languages = this.settings.aiAllowedLanguages || 'English';
        const fallback = this.settings.aiFallbackLanguage || 'English';
        const userPrompt = `Term: "${term}"

Context:
"${context}"

Allowed languages: [${languages}]. Fallback: ${fallback}.`;

        try {
            const response = await api.chatCompletions<unknown>(
                {
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: userPrompt }
                    ],
                    temperature: 0.3,
                    max_tokens: 1000,
                },
                {
                    selection: this.resolveMetadataSelection(api),
                }
            );

            const contentStr = this.extractTextFromResponse(response.data);
            if (!contentStr) {
                console.error('[AI Metadata] No content in response');
                return null;
            }

            let jsonStr = contentStr.trim();

            // Remove markdown code blocks if present
            const jsonBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
            if (jsonBlockMatch) {
                jsonStr = jsonBlockMatch[1].trim();
            }

            // Remove control characters that break JSON parsing
            jsonStr = jsonStr.replace(/[\x00-\x1F\x7F]/g, (char) => {
                if (char === '\n' || char === '\r' || char === '\t') return char;
                return '';
            });

            // Try to parse as JSON
            let metadata: any;
            try {
                metadata = JSON.parse(jsonStr);
            } catch (jsonError) {
                // Fallback: Try to extract title and aliases from YAML-like format
                const titleMatch = jsonStr.match(/title:\s*["']?([^"'\n]+)["']?/);
                const aliasesMatch = jsonStr.match(/aliases:\s*\[([\s\S]*?)\]/);
                const antialiasesMatch = jsonStr.match(/antialiases:\s*\[([\s\S]*?)\]/i);
                const exactMatchOnlyMatch = jsonStr.match(/exactMatchOnly:\s*([^\n]+)/i);
                const exactFrontmatterMatch = jsonStr.match(new RegExp(`${this.escapeRegExp(this.settings.propertyNameExactMatchOnly)}\\s*:\\s*([^\\n]+)`, 'i'));

                if (titleMatch) {
                    const aliases: string[] = [];
                    if (aliasesMatch) {
                        const aliasContent = aliasesMatch[1];
                        const aliasMatches = aliasContent.match(/["']([^"']+)["']/g);
                        if (aliasMatches) {
                            aliases.push(...aliasMatches.map(a => a.replace(/["']/g, '')));
                        }
                    }
                    const antialiases: string[] = [];
                    if (antialiasesMatch) {
                        const antialiasContent = antialiasesMatch[1];
                        const antialiasItems = antialiasContent.match(/["']([^"']+)["']/g);
                        if (antialiasItems) {
                            antialiases.push(...antialiasItems.map(a => a.replace(/["']/g, '')));
                        }
                    }
                    metadata = {
                        title: titleMatch[1].trim(),
                        aliases,
                        antialiases,
                        exactMatchOnly: this.parseBooleanLike(exactMatchOnlyMatch?.[1]) ?? this.parseBooleanLike(exactFrontmatterMatch?.[1]),
                    };
                } else {
                    console.error('[AI Metadata] Could not parse response:', jsonStr);
                    return null;
                }
            }

            const exactFromNamedField = this.parseBooleanLike(metadata.exactMatchOnly);
            const exactFromFrontmatterField = this.parseBooleanLike(metadata[this.settings.propertyNameExactMatchOnly]);
            const exactFromDefaultField = this.parseBooleanLike(metadata['linker-exact-match-only']);

            return {
                title: metadata.title,
                aliases: Array.isArray(metadata.aliases) ? metadata.aliases : [],
                antialiases: Array.isArray(metadata.antialiases) ? metadata.antialiases : [],
                exactMatchOnly: exactFromNamedField ?? exactFromFrontmatterField ?? exactFromDefaultField,
            };
        } catch (error) {
            console.error('[AI Metadata Error]', error);
            return null;
        }
    }

    async createGlossaryEntry(term: string, definition: string, metadata?: GlossaryMetadata): Promise<TFile | null> {
        const targetFolder = this.settings.linkerDirectories[0] || 'Glossary';

        // ============================================
        // STEP 1: Extract title from AI response first
        // ============================================
        let cleanDefinition = definition.trim();
        let extractedFrontmatter = '';
        let extractedTitle = '';

        // Try to extract frontmatter - handle multiple formats
        const properFrontmatterRegex = /---\s*([\s\S]*?)\s*---/;
        let match = cleanDefinition.match(properFrontmatterRegex);

        if (match) {
            extractedFrontmatter = match[1];
            cleanDefinition = cleanDefinition.replace(properFrontmatterRegex, '').trim();

            // Extract title from frontmatter YAML
            const fmTitleMatch = extractedFrontmatter.match(/^title:\s*["']?([^"'\n]+)["']?\s*$/m);
            if (fmTitleMatch) {
                extractedTitle = fmTitleMatch[1].trim();
            }
        } else {
            // Fallback: malformed frontmatter
            const malformedRegex = /^---\s*([\s\S]*?)(?=\n#|\n\n#)/;
            match = cleanDefinition.match(malformedRegex);
            if (match) {
                extractedFrontmatter = match[1].trim();
                cleanDefinition = cleanDefinition.replace(malformedRegex, '').trim();

                const fmTitleMatch = extractedFrontmatter.match(/^title:\s*["']?([^"'\n]+)["']?\s*$/m);
                if (fmTitleMatch) {
                    extractedTitle = fmTitleMatch[1].trim();
                }
            }
        }

        // If no title from frontmatter, extract from # Heading
        if (!extractedTitle) {
            const headingMatch = cleanDefinition.match(/^#\s+(.+)$/m);
            if (headingMatch) {
                extractedTitle = headingMatch[1].trim();
            }
        }

        // ============================================
        // STEP 2: Determine final title (priority: metadata > extracted > term)
        // ============================================
        const title = metadata?.title || extractedTitle || term;
        // If title contains LaTeX, use a stripped plain-text version for the filename
        const hasLatex = /[\\{}]/.test(title);
        const filenameTitle = hasLatex ? this.stripLatexForFilename(title) : title;
        const sanitizedTitle = filenameTitle.replace(/[\\/:*?"<>|]/g, '-').trim() || 'untitled';
        const filePath = normalizePath(`${targetFolder}/${sanitizedTitle}.md`);

        // Check for existing file
        const existingFile = this.app.vault.getAbstractFileByPath(filePath);
        if (existingFile) {
            new Notice(`Glossary entry "${sanitizedTitle}" already exists`);
            return existingFile as TFile;
        }

        // Create folder if needed
        const folder = this.app.vault.getAbstractFileByPath(targetFolder);
        if (!folder) {
            try { await this.app.vault.createFolder(targetFolder); } catch (e) { }
        }

        // ============================================
        // STEP 3: Remove title redundancy from content
        // ============================================

        // Remove title heading that matches the term
        const titleRegex = new RegExp(`^#\\s*${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'im');
        cleanDefinition = cleanDefinition.replace(titleRegex, '').trim();

        // Also remove title that matches the final title if different
        if (title !== term) {
            const metaTitleRegex = new RegExp(`^#\\s*${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'im');
            cleanDefinition = cleanDefinition.replace(metaTitleRegex, '').trim();
        }

        // Prepare aliases from separate metadata
        const metadataAliases = (metadata?.aliases || []).filter(a => a && a !== title);

        // If the filename was stripped of LaTeX, add the original LaTeX form as an alias
        // so the math linker can find and match it
        if (hasLatex && !metadataAliases.some(a => a === title)) {
            metadataAliases.unshift(title);
        }

        // Add original term as alias if it differs from the title (case-insensitive comparison)
        if (term.toLowerCase() !== title.toLowerCase() && !metadataAliases.some(a => a.toLowerCase() === term.toLowerCase())) {
            metadataAliases.unshift(term);
        }

        // Construct final frontmatter
        let finalFrontmatter = '';

        if (extractedFrontmatter) {
            // Check if aliases already exist in extracted frontmatter to avoid duplicates or overwriting
            finalFrontmatter = extractedFrontmatter.trim();
            if (metadataAliases.length > 0 && !finalFrontmatter.includes('aliases:')) {
                finalFrontmatter += `\naliases:\n${metadataAliases.map(a => `  - ${this.yamlQuote(a)}`).join('\n')}`;
            }
        } else {
            // No AI frontmatter, create default
            finalFrontmatter = metadataAliases.length > 0
                ? `aliases:\n${metadataAliases.map(a => `  - ${this.yamlQuote(a)}`).join('\n')}`
                : `aliases: []`;
        }

        const exactPropertyName = this.settings.propertyNameExactMatchOnly || 'linker-exact-match-only';
        const hasExactProperty = new RegExp(`^\\s*${this.escapeRegExp(exactPropertyName)}\\s*:`, 'm').test(finalFrontmatter);
        if (!hasExactProperty) {
            const exactMatchOnly = metadata?.exactMatchOnly === true;
            finalFrontmatter += `\n${exactPropertyName}: ${exactMatchOnly ? 'true' : 'false'}`;
        }

        const antialiasPropertyName = this.settings.propertyNameAntialiases || 'antialiases';
        const hasAntialiasProperty = new RegExp(`^\\s*${this.escapeRegExp(antialiasPropertyName)}\\s*:`, 'm').test(finalFrontmatter);
        if (!hasAntialiasProperty) {
            const antialiases = Array.isArray(metadata?.antialiases) ? metadata!.antialiases!.filter(Boolean) : [];
            if (antialiases.length > 0) {
                finalFrontmatter += `\n${antialiasPropertyName}:\n${antialiases.map(a => `  - ${this.yamlQuote(a)}`).join('\n')}`;
            } else {
                finalFrontmatter += `\n${antialiasPropertyName}: []`;
            }
        }

        // Build final content - ensure no leading/trailing whitespace
        const headingTitle = hasLatex ? `$` + title + `$` : title;
        const content = `---
${finalFrontmatter.trim()}
---

# ${headingTitle}

${cleanDefinition.trim()}
`.trim() + '\n';

        try {
            const file = await this.app.vault.create(filePath, content);
            new Notice(`Created glossary entry: ${sanitizedTitle}`);
            return file;
        } catch (error) {
            new Notice(`Failed to create entry: ${error instanceof Error ? error.message : String(error)}`);
            return null;
        }
    }

    async createEntryFromSelection(
        term: string,
        context: string,
        options: CreateEntryFromSelectionOptions = {}
    ): Promise<TFile | null> {
        new Notice(`Generating definition for "${term}"...`);

        // Run definition and metadata generation in parallel if enabled
        const definitionPromise = this.generateDefinitionStreaming(term, context);
        let metadataPromise: Promise<GlossaryMetadata | null> = Promise.resolve(null);

        if (this.settings.aiGenerateMetadata) {
            metadataPromise = this.generateMetadata(term, context);
        }

        let definitionResult: AIGenerationResult = { success: false, error: 'Definition generation failed' };
        try {
            definitionResult = await definitionPromise;
        } finally {
            try {
                options.onDefinitionComplete?.();
            } catch (error) {
                console.error('[AI] onDefinitionComplete callback failed', error);
            }
        }

        if (!definitionResult.success || !definitionResult.definition) {
            new Notice(definitionResult.error || 'Failed to generate definition');
            return null;
        }

        const metadataResult = await metadataPromise;
        const metadata = metadataResult || undefined;
        return this.createGlossaryEntry(term, definitionResult.definition, metadata);
    }
}

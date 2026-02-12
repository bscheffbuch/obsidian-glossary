import { App, Notice, TFile, normalizePath, requestUrl, MarkdownRenderer, Component } from 'obsidian';
import { LinkerPluginSettings, AIProviderConfig, AI_PROVIDER_PRESETS } from '../main';

export interface AIGenerationResult {
    success: boolean;
    definition?: string;
    error?: string;
}

export interface ModelListResult {
    success: boolean;
    models?: string[];
    error?: string;
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

    getActiveProvider(): AIProviderConfig | null {
        const savedConfig = this.settings.aiProviders.find(p => p.id === this.settings.aiActiveProvider);
        if (savedConfig) return savedConfig;
        const preset = AI_PROVIDER_PRESETS.find(p => p.id === this.settings.aiActiveProvider);
        if (preset) return { ...preset, apiKey: '' };
        return null;
    }

    async fetchModels(): Promise<ModelListResult> {
        const provider = this.getActiveProvider();
        if (!provider) return { success: false, error: 'No provider configured' };
        if (!provider.apiKey) return { success: false, error: 'API key not set' };
        if (!provider.modelsEndpoint) return { success: false, error: 'Provider does not support model listing' };

        try {
            const headers: Record<string, string> = { 'Authorization': `Bearer ${provider.apiKey}` };
            if (provider.id === 'anthropic') {
                headers['x-api-key'] = provider.apiKey;
                headers['anthropic-version'] = '2023-06-01';
                delete headers['Authorization'];
            }

            const response = await requestUrl({ url: provider.modelsEndpoint, method: 'GET', headers });
            const data = response.json;
            let models: string[] = [];

            if (data.data && Array.isArray(data.data)) {
                models = data.data.map((m: any) => m.id || m.name).filter(Boolean);
            } else if (data.models && Array.isArray(data.models)) {
                models = data.models.map((m: any) => m.id || m.name || m).filter(Boolean);
            }
            models = models.sort();
            return { success: true, models };
        } catch (error) {
            return { success: false, error: `Failed to fetch models: ${error instanceof Error ? error.message : String(error)}` };
        }
    }

    async generateDefinitionStreaming(term: string, context: string): Promise<AIGenerationResult> {
        if (!this.settings.aiEnabled) return { success: false, error: 'AI generation is not enabled' };
        const provider = this.getActiveProvider();
        if (!provider) return { success: false, error: 'No AI provider configured' };
        if (!provider.apiKey) return { success: false, error: 'API key is not configured' };

        const languages = this.settings.aiAllowedLanguages || 'English';
        const fallback = this.settings.aiFallbackLanguage || 'English';
        const userPrompt = `Term: "${term}"

Context where the term appears:
"${context}"

Language settings: Allowed languages are [${languages}]. If the term is not in one of these languages, use ${fallback}.`;
        const preview = new StreamingPreview(this.app);
        let fullContent = '';

        // Create status bar indicator
        const statusEl = document.body.querySelector('.status-bar')?.createDiv({ cls: 'status-bar-item ai-status' });
        if (statusEl) {
            statusEl.setText('AI starting...');
        }

        try {
            const headers: Record<string, string> = {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${provider.apiKey}`,
            };

            let body: any;
            if (provider.id === 'anthropic') {
                headers['x-api-key'] = provider.apiKey;
                headers['anthropic-version'] = '2023-06-01';
                delete headers['Authorization'];
                body = {
                    model: provider.model,
                    max_tokens: 500,
                    stream: true,
                    system: this.getEffectiveSystemPrompt(),
                    messages: [{ role: 'user', content: userPrompt }],
                };
            } else {
                body = {
                    model: provider.model,
                    messages: [
                        { role: 'system', content: this.getEffectiveSystemPrompt() },
                        { role: 'user', content: userPrompt }
                    ],
                    temperature: 0.7,
                    max_tokens: this.settings.aiMaxTokens,
                    stream: true,
                };
            }

            // Longer timeout for models with extended thinking (2 minutes)
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 120000);

            const response = await fetch(provider.endpoint, {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
                signal: controller.signal,
                keepalive: true,
            });

            clearTimeout(timeoutId);
            if (!response.ok) {
                const errorText = await response.text();
                console.error('[AI Error Response]', errorText);
                preview.updateContent(`Error: ${response.status} - ${errorText}`);
                preview.finishGeneration(false);
                return { success: false, error: `API error: ${response.status} - ${errorText}` };
            }

            const reader = response.body?.getReader();
            if (!reader) {
                console.error('[AI Error] No response body reader');
                preview.finishGeneration(false);
                return { success: false, error: 'No response stream' };
            }

            const decoder = new TextDecoder();
            let lineBuffer = '';  // Buffer for incomplete lines
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const chunk = decoder.decode(value, { stream: true });
                lineBuffer += chunk;

                // Process complete lines (ending with \n)
                const lines = lineBuffer.split('\n');
                // Keep the last incomplete line in buffer
                lineBuffer = lines.pop() || '';

                for (const line of lines) {
                    const trimmedLine = line.trim();
                    if (!trimmedLine) continue;

                    if (trimmedLine.startsWith('data: ')) {
                        const data = trimmedLine.slice(6).trim();
                        if (data === '[DONE]') continue;

                        try {
                            const json = JSON.parse(data);
                            let contentChunk = '';

                            if (provider.id === 'anthropic') {
                                if (json.type === 'content_block_delta') {
                                    contentChunk = json.delta?.text || '';
                                }
                            } else {
                                // OpenAI-compatible: only use content, ignore reasoning
                                const delta = json.choices?.[0]?.delta;
                                contentChunk = delta?.content || '';

                                // Update status bar based on what's being received
                                if (delta?.reasoning && !contentChunk) {
                                    statusEl?.setText('AI thinking...');
                                } else if (contentChunk) {
                                    statusEl?.setText('AI generating...');
                                }
                            }

                            if (contentChunk) {
                                fullContent += contentChunk;
                                await preview.updateContent(fullContent);
                            }
                        } catch (e) {
                            // Skip invalid JSON - might be truncated
                            console.log('[AI Parse Error]', data.slice(0, 100));
                        }
                    } else if (trimmedLine.startsWith(':')) {
                        // SSE comment (e.g., ": OPENROUTER PROCESSING"), skip
                        statusEl?.setText('AI connecting...');
                    }
                }
            }

            statusEl?.remove();

            if (!fullContent.trim()) {
                preview.finishGeneration(false);
                console.error('[AI Error] Stream completed but no content received');
                return { success: false, error: 'Stream completed but no content received. Model may still be thinking - try a faster model.' };
            }

            preview.finishGeneration(true);
            return { success: true, definition: fullContent.trim() };
        } catch (error) {
            console.error('[AI Error]', error);
            statusEl?.remove();
            preview.finishGeneration(false);
            return { success: false, error: `Request failed: ${error instanceof Error ? error.message : String(error)}` };
        }
    }

    async generateDefinition(term: string, context: string): Promise<AIGenerationResult> {
        if (!this.settings.aiEnabled) return { success: false, error: 'AI generation is not enabled' };
        const provider = this.getActiveProvider();
        if (!provider) return { success: false, error: 'No AI provider configured' };
        if (!provider.apiKey) return { success: false, error: 'API key is not configured' };

        const userPrompt = `Term: "${term}"\n\nContext where the term appears:\n"${context}"`;

        try {
            const headers: Record<string, string> = {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${provider.apiKey}`,
            };

            let body: any;
            if (provider.id === 'anthropic') {
                headers['x-api-key'] = provider.apiKey;
                headers['anthropic-version'] = '2023-06-01';
                delete headers['Authorization'];
                body = {
                    model: provider.model,
                    max_tokens: this.settings.aiMaxTokens,
                    system: this.getEffectiveSystemPrompt(),
                    messages: [{ role: 'user', content: userPrompt }],
                };
            } else {
                body = {
                    model: provider.model,
                    messages: [
                        { role: 'system', content: this.getEffectiveSystemPrompt() },
                        { role: 'user', content: userPrompt }
                    ],
                    temperature: 0.7,
                    max_tokens: this.settings.aiMaxTokens,
                };
            }

            const response = await requestUrl({ url: provider.endpoint, method: 'POST', headers, body: JSON.stringify(body) });
            const data = response.json;

            let definition: string | undefined;
            if (provider.id === 'anthropic') {
                definition = data.content?.[0]?.text?.trim();
            } else {
                // Try multiple extraction paths for different API formats
                const choice = data.choices?.[0];
                definition = choice?.message?.content?.trim()
                    || choice?.text?.trim()
                    || choice?.content?.trim();

            }

            if (!definition) {
                console.error('[AI Error] No definition. Full response:', JSON.stringify(data).slice(0, 1000));
                return { success: false, error: `No response from AI. Check console for details.` };
            }
            return { success: true, definition };
        } catch (error) {
            console.error('[AI Error]', error);
            return { success: false, error: `Request failed: ${error instanceof Error ? error.message : String(error)}` };
        }
    }

    async generateMetadata(term: string, context: string): Promise<GlossaryMetadata | null> {
        if (!this.settings.aiEnabled || !this.settings.aiGenerateMetadata) return null;

        const provider = this.getActiveProvider();
        if (!provider || !provider.apiKey) return null;

        // Use metadata-specific model or fallback to main model
        const model = this.settings.aiMetadataModel || provider.model;
        const systemPrompt = this.substitutePromptVariables(this.settings.aiMetadataSystemPrompt);
        const languages = this.settings.aiAllowedLanguages || 'English';
        const fallback = this.settings.aiFallbackLanguage || 'English';
        const userPrompt = `Term: "${term}"

Context:
"${context}"

Allowed languages: [${languages}]. Fallback: ${fallback}.`;

        try {
            const headers: Record<string, string> = {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${provider.apiKey}`,
            };

            let body: any;
            if (provider.id === 'anthropic') {
                headers['x-api-key'] = provider.apiKey;
                headers['anthropic-version'] = '2023-06-01';
                delete headers['Authorization'];
                body = {
                    model: model,
                    max_tokens: 1000,
                    system: systemPrompt,
                    messages: [{ role: 'user', content: userPrompt }],
                };
            } else {
                body = {
                    model: model,
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: userPrompt }
                    ],
                    temperature: 0.3, // Lower temperature for structured data
                    max_tokens: 1000,
                };
            }

            const response = await requestUrl({ url: provider.endpoint, method: 'POST', headers, body: JSON.stringify(body) });
            const data = response.json;

            let contentStr: string | undefined;

            if (provider.id === 'anthropic') {
                contentStr = data.content?.[0]?.text;
            } else {
                // Try multiple possible locations for content
                contentStr = data.choices?.[0]?.message?.content
                    || data.choices?.[0]?.text
                    || data.choices?.[0]?.delta?.content;
            }

            if (!contentStr) {
                console.error('[AI Metadata] No content in response');
                return null;
            }

            // Clean and extract JSON from response
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

    async createEntryFromSelection(term: string, context: string): Promise<TFile | null> {
        new Notice(`Generating definition for "${term}"...`);

        // Run definition and metadata generation in parallel if enabled
        const definitionPromise = this.generateDefinitionStreaming(term, context);
        let metadataPromise: Promise<GlossaryMetadata | null> = Promise.resolve(null);

        if (this.settings.aiGenerateMetadata) {
            metadataPromise = this.generateMetadata(term, context);
        }

        const [definitionResult, metadataResult] = await Promise.all([definitionPromise, metadataPromise]);

        if (!definitionResult.success || !definitionResult.definition) {
            new Notice(definitionResult.error || 'Failed to generate definition');
            return null;
        }

        const metadata = metadataResult || undefined;
        return this.createGlossaryEntry(term, definitionResult.definition, metadata);
    }
}

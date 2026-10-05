import type { SettingItem } from './types';

// GEMINI-PDF-INPUT settings, on Chat bot > Model under the model pickers (the
// user's request, 2026-10-06: easier to find there than in Advanced > Request;
// ids unchanged). The chat input's ☰ menu toggles the same switch while the
// chat sends to Gemini (DefaultChatScreen.svelte).
export const geminiPdfInputItems: SettingItem[] = [
    {
        // One global switch for every native-Gemini request (classic
        // Google/Vertex models and google-gemini model presets).
        id: 'adv.geminiPdfInput', type: 'check', labelKey: 'nodeOnlyGeminiPdfInput', bindKey: 'nodeOnlyGeminiPdfInput',
        helpKey: 'nodeOnlyGeminiPdfInput', showExperimental: true,
        keywords: ['gemini', 'vertex', 'pdf', 'token', 'cost', '제미나이', '토큰', '비용'],
    },
    {
        // Media resolution of that PDF; only meaningful while it is on.
        id: 'adv.geminiPdfMediaResolution', type: 'select', labelKey: 'nodeOnlyGeminiPdfMediaResolution',
        bindKey: 'nodeOnlyGeminiPdfMediaResolution', helpKey: 'nodeOnlyGeminiPdfMediaResolution',
        condition: (ctx) => ctx.db.nodeOnlyGeminiPdfInput === true,
        options: {
            selectOptions: [
                { value: 'default', labelKey: 'geminiPdfMediaResolutionDefault' },
                { value: 'low', labelKey: 'geminiPdfMediaResolutionLow' },
                { value: 'medium', labelKey: 'geminiPdfMediaResolutionMedium' },
                { value: 'high', labelKey: 'geminiPdfMediaResolutionHigh' },
            ]
        },
        keywords: ['gemini', 'pdf', 'media resolution', 'resolution', 'token', '해상도', '토큰'],
    },
];

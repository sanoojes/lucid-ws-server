export interface ThemeConfig {
	key: string;
	name: string;
}

export const THEMES: Record<string, ThemeConfig> = {
	theme: { key: "lucid_theme:users", name: "Lucid Theme" },
	lyrics_extension: { key: "lucid_lyrics:users", name: "Lyrics Extension" },
	glassify_theme: { key: "glassify_theme:users", name: "Glassify Theme" },
};

export const HISTORICAL_KEY_PREFIX = "lucid_activity";
export type AnalyticType = keyof typeof THEMES;

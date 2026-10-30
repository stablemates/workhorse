// Configure IconRendererProvider with your installed icon pack or licensed files.
// Until configured, the shared renderer uses the official Lucide package and
// marks substitutions with data-icon-fallback. No vendor artwork is bundled.
type Artwork = { viewBox: string; body: string; lightBody: string; boldBody: string; thinBody: string; filledBody: string };
export const THEME_ICON_ARTWORK: { Central: Record<string, Artwork>; Phosphor: Record<string, Artwork> } = { Central: {}, Phosphor: {} };
export const CENTRAL_OUTLINE_ARTWORK: Record<string, Artwork> = {};
export const CENTRAL_CONTROL_OUTLINES: Record<string, Artwork> = {};
export const CENTRAL_CONTROL_FILLS: Record<string, Artwork> = {};
export const CENTRAL_CONTROL_STROKES: Partial<Record<string, string>> = {};
export const PHOSPHOR_CONTROL_ARTWORK: Record<string, Artwork> = {};
export const LUCIDE_FILLED_ARTWORK: Record<string, { body: string; cutouts?: string }> = {};
export const LUCIDE_CONTROL_FILLS: Record<string, { body: string; cutouts?: string }> = {};

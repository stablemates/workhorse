// Public names are independent of the identities used by saved themes and URLs.
export const THEME_STYLE_NAMES = {
  Atlas: 'Felt',
  Forma: 'Alloy',
  Grove: 'Canvas',
  Lustre: 'Jelly',
  Charter: 'Paper',
} as const;

export function themeStyleName(identity: string): string {
  return Object.hasOwn(THEME_STYLE_NAMES, identity)
    ? THEME_STYLE_NAMES[identity as keyof typeof THEME_STYLE_NAMES]
    : identity;
}

export function themeStyleIdentity(name: string): string {
  return (
    Object.entries(THEME_STYLE_NAMES).find(
      ([, label]) => label === name,
    )?.[0] ?? name
  );
}

'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { Button as BaseButton } from '@base-ui/react/button';
import { Input as BaseInput } from '@base-ui/react/input';
import { Select as BaseSelect } from '@base-ui/react/select';
import {
  ComponentTheme,
  createAppearanceResolver,
  themeContainer,
  themePart,
} from "./component-theme.js";
import {
  previewCssVariables,
  type ColorMode,
  type ThemeDocument,
} from "../../lib/theme-model.js";

const DocumentContext = createContext<{
  document: ThemeDocument;
  colorMode: ColorMode;
} | null>(null);

/** Application-wide theme scope. ComponentTheme also carries these values into portals. */
export function GraphicalProvider({
  document,
  colorMode = 'light',
  children,
}: {
  document: ThemeDocument;
  colorMode?: ColorMode;
  children: ReactNode;
}) {
  // Keep resolver identities such as --theme-name intact: components use them
  // for style behavior. document.name is the separate user-facing display name.
  const variables = useMemo(
    () => previewCssVariables(document.theme, colorMode),
    [document.theme, colorMode],
  );
  const resolve = useMemo(
    () => createAppearanceResolver(document, colorMode),
    [document, colorMode],
  );
  const value = useMemo(() => ({ document, colorMode }), [document, colorMode]);
  return (
    <DocumentContext value={value}>
      <ComponentTheme
        component="button"
        appearances={resolve('button')}
        variables={variables}
        resolveComponent={resolve}
      >
        <div
          className="graphical-theme"
          data-graphical-theme={document.theme.name}
          data-color-mode={colorMode}
          style={{ ...variables, colorScheme: colorMode }}
        >
          {children}
        </div>
      </ComponentTheme>
    </DocumentContext>
  );
}

export function useGraphicalTheme() {
  const value = useContext(DocumentContext);
  if (!value) throw new Error('useGraphicalTheme requires GraphicalProvider');
  return value;
}

// Keep the complete Base UI props, refs, render, and event contracts.
export const Button = themePart(BaseButton, 'button', 'control', 'ui-button');
export const ButtonLabel = themePart('span', 'button', 'label');
export const Input = themePart(BaseInput, 'input', 'control', 'ui-input');
export const Select = {
  ...BaseSelect,
  Label: themePart(BaseSelect.Label, 'select', 'label', 'ui-label'),
  Trigger: themePart(
    BaseSelect.Trigger,
    'select',
    'control',
    'ui-button ui-spread',
  ),
  Positioner: themeContainer(BaseSelect.Positioner, 'ui-positioner'),
  Popup: themePart(BaseSelect.Popup, 'select', 'popover', 'ui-popup ui-menu'),
  Item: themePart(BaseSelect.Item, 'select', 'option', 'ui-option'),
};

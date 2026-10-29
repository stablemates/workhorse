import type { ComponentPartId } from "./component-parts.js";
import type { ButtonVariant, ComponentId, ThemeDocument } from "./theme-model.js";

export type ComponentReference = {
  component: ComponentId;
  part: ComponentPartId;
  variant?: ButtonVariant;
};
const button = (variant: ButtonVariant): ComponentReference => ({
  component: 'button',
  part: 'control',
  variant,
});
const parts = (component: ComponentId, names: ComponentPartId[]) =>
  Object.fromEntries(
    names.map((part) => [part, { component, part }]),
  ) as Partial<Record<ComponentPartId, ComponentReference>>;
const modal = {
  trigger: button('outline'),
  action: button('primary'),
  close: button('ghost'),
};
const field = {
  ...parts('field', ['label', 'description', 'error', 'input']),
  content: { component: 'field', part: 'group' } as ComponentReference,
};

/** The specimen supplies a role; its referenced component owns the design. */
export const COMPONENT_REFERENCES: Partial<
  Record<ComponentId, Partial<Record<ComponentPartId, ComponentReference>>>
> = {
  'alert-dialog': { ...modal, close: button('outline') },
  dialog: modal,
  drawer: modal,
  popover: modal,
  menu: { trigger: button('outline') },
  'context-menu': {
    action: button('outline'),
    ...parts('menu', ['popover', 'option', 'indicator', 'separator']),
  },
  tooltip: { trigger: button('ghost') },
  toast: {
    trigger: button('outline'),
    action: button('secondary'),
    close: button('ghost'),
  },
  'checkbox-group': parts('checkbox', ['control', 'indicator', 'label']),
  'radio-group': parts('radio', ['control', 'indicator', 'label']),
  'toggle-group': parts('toggle', ['control', 'label']),
  toolbar: {
    ...parts('toggle', ['control', 'label']),
    ...parts('separator', ['separator']),
  },
  menubar: parts('menu', [
    'label',
    'popover',
    'option',
    'indicator',
    'separator',
  ]),
  'number-field': { input: { component: 'input', part: 'control' } },
  field: { input: { component: 'input', part: 'control' } },
  fieldset: field,
  form: { ...field, action: button('primary') },
};

export function getComponentReference(
  component: ComponentId,
  part: ComponentPartId,
) {
  return COMPONENT_REFERENCES[component]?.[part];
}
export function componentReferenceKey(
  component: ComponentId,
  part: ComponentPartId,
) {
  return `${component}:${part}`;
}
export function configuredComponentReference(
  document: ThemeDocument,
  component: ComponentId,
  part: ComponentPartId,
): ComponentReference | undefined {
  const reference = getComponentReference(component, part);
  if (!reference) return undefined;
  return reference.component === 'button'
    ? {
        ...reference,
        variant:
          document.componentVariants?.[
            componentReferenceKey(component, part)
          ] ?? reference.variant,
      }
    : reference;
}
/** Follow composition through Field/Input or Menubar/Menu to the editable source. */
export function componentReferenceSource(
  document: ThemeDocument,
  component: ComponentId,
  part: ComponentPartId,
): ComponentReference | undefined {
  let reference = configuredComponentReference(document, component, part);
  if (!reference) return undefined;
  const visited = new Set<string>([componentReferenceKey(component, part)]);
  while (reference) {
    const key = componentReferenceKey(reference.component, reference.part);
    if (visited.has(key))
      throw new Error(`Circular component reference: ${key}`);
    visited.add(key);
    const next = configuredComponentReference(
      document,
      reference.component,
      reference.part,
    );
    if (!next) return reference;
    reference = next;
  }
}
export function setComponentReferenceVariant(
  document: ThemeDocument,
  component: ComponentId,
  part: ComponentPartId,
  variant: ButtonVariant,
): ThemeDocument {
  if (getComponentReference(component, part)?.component !== 'button')
    throw new Error(
      `Only Button instances have a variant: ${component}:${part}`,
    );
  return {
    ...document,
    componentVariants: {
      ...document.componentVariants,
      [componentReferenceKey(component, part)]: variant,
    },
  };
}

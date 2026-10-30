import type { ThemeDocument } from './lib/theme-model.js';

// Exact current project snapshot. Keep the internal theme identity for preview behavior.
export const theme: ThemeDocument = {
  "schemaVersion": 2,
  "name": "Untitled",
  "theme": {
    "name": "Atlas",
    "primaryForeground": {
      "light": "neutral-2",
      "dark": "neutral-2"
    },
    "iconFamily": "Hugeicons",
    "animation": {
      "duration": 160,
      "easing": [
        0.16,
        1,
        0.3,
        1
      ],
      "large": {
        "type": "easing",
        "duration": 280,
        "easing": [
          0.16,
          1,
          0.3,
          1
        ],
        "visualDuration": 0.36,
        "bounce": 0.3
      },
      "popupScale": 0.96,
      "pressDistance": 1,
      "type": "easing",
      "visualDuration": 0.2,
      "bounce": 0.2
    },
    "colors": {
      "light": {
        "neutral-1": "#ffffff",
        "neutral-2": "#fbfbfb",
        "neutral-3": "#f4f4f4",
        "neutral-4": "#e7e7e7",
        "neutral-5": "#cdcdcd",
        "neutral-6": "#a1a1a1",
        "neutral-7": "#7d7d7d",
        "neutral-8": "#555555",
        "neutral-9": "#333333",
        "neutral-10": "#000000",
        "color-1": "#cf9148",
        "color-2": "#07376b",
        "color-3": "#c9b8f5",
        "color-4": "#ffe0b8",
        "success": "#00906c",
        "warning": "#ffea00",
        "error": "#fc032d"
      },
      "dark": {
        "neutral-1": "#000000",
        "neutral-2": "#202020",
        "neutral-3": "#2b2b2b",
        "neutral-4": "#3d3d3d",
        "neutral-5": "#565656",
        "neutral-6": "#838383",
        "neutral-7": "#ababab",
        "neutral-8": "#cfcfcf",
        "neutral-9": "#f4f4f4",
        "neutral-10": "#ffffff",
        "color-1": "#cf9148",
        "color-2": "#07376b",
        "color-3": "#c9b8f5",
        "color-4": "#ffe0b8",
        "success": "#00906c",
        "warning": "#ffea00",
        "error": "#fc032d"
      }
    },
    "spacing": {
      "zero": 0,
      "xxs": 4,
      "xs": 8,
      "s": 12,
      "m": 16,
      "l": 24,
      "xl": 32,
      "xxl": 48
    },
    "text": {
      "xxs": {
        "size": 10,
        "lineHeight": 14
      },
      "xs": {
        "size": 12,
        "lineHeight": 16
      },
      "s": {
        "size": 14,
        "lineHeight": 20
      },
      "m": {
        "size": 16,
        "lineHeight": 24
      },
      "l": {
        "size": 24,
        "lineHeight": 32
      },
      "xl": {
        "size": 36,
        "lineHeight": 40
      },
      "xxl": {
        "size": 48,
        "lineHeight": 52
      }
    },
    "fonts": {
      "ui": {
        "family": "\"Timeless Grotesk\", sans-serif",
        "weights": {
          "regular": 400,
          "medium": 500,
          "heavy": 600
        }
      },
      "brand": {
        "family": "\"Timeless Grotesk\", sans-serif",
        "weights": {
          "regular": 400,
          "medium": 500,
          "heavy": 600
        }
      },
      "editorial": {
        "family": "\"Timeless Grotesk\", sans-serif",
        "weights": {
          "regular": 400,
          "medium": 500,
          "heavy": 600
        }
      },
      "data": {
        "family": "\"Timeless Grotesk\", sans-serif",
        "weights": {
          "regular": 400,
          "medium": 500,
          "heavy": 600
        }
      }
    },
    "radius": {
      "zero": 0,
      "xs": 4.08,
      "s": 8.16,
      "m": 12.16,
      "l": 17.84,
      "xl": 27.52,
      "full": 9999
    },
    "border": {
      "none": 0,
      "s": 0,
      "m": 0,
      "l": 0
    },
    "shadows": {
      "s": {
        "x": 0,
        "y": 2,
        "blur": 4,
        "spread": 0,
        "opacity": 0,
        "color": {
          "light": "neutral-10",
          "dark": "neutral-1"
        }
      },
      "m": {
        "x": 0,
        "y": 8,
        "blur": 24,
        "spread": 0,
        "opacity": 12,
        "color": {
          "light": "neutral-10",
          "dark": "neutral-1"
        }
      },
      "l": {
        "x": 0,
        "y": 16,
        "blur": 48,
        "spread": 0,
        "opacity": 0,
        "color": {
          "light": "neutral-10",
          "dark": "neutral-1"
        }
      }
    },
    "iconStyle": "outlined",
    "hugeiconsVariant": "stroke-rounded",
    "buttonRadius": "s",
    "primaryActionColor": "neutral-10",
    "colorEmphasis": 52,
    "neutralTone": "neutral",
    "letterSpacing": {
      "xs": -0.02,
      "s": -0.01,
      "m": 0,
      "l": 0.01,
      "xl": 0.02
    },
    "colorPalettes": [
      {
        "id": "atlas-party",
        "name": "Party orange",
        "description": "Orange with deep blue, clear sky, and soft peach.",
        "colors": {
          "light": [
            "#ff5a00",
            "#153d85",
            "#bfe8f5",
            "#ffd0b0"
          ],
          "dark": [
            "#ff5a00",
            "#153d85",
            "#bfe8f5",
            "#ffd0b0"
          ]
        },
        "primaryForeground": {
          "light": "neutral-2",
          "dark": "neutral-2"
        }
      },
      {
        "id": "atlas-nectarine",
        "name": "Nectarine",
        "description": "Golden orange with pine, peach, and a little violet.",
        "colors": {
          "light": [
            "#ff9800",
            "#00906c",
            "#ffd3af",
            "#5100c0"
          ],
          "dark": [
            "#ff9800",
            "#00906c",
            "#ffd3af",
            "#5100c0"
          ]
        },
        "primaryForeground": {
          "light": "neutral-9",
          "dark": "neutral-2"
        }
      },
      {
        "id": "atlas-caramel",
        "name": "Caramel",
        "description": "Warm caramel with deep blue, lavender, and pale apricot.",
        "colors": {
          "light": [
            "#cf9148",
            "#07376b",
            "#c9b8f5",
            "#ffe0b8"
          ],
          "dark": [
            "#cf9148",
            "#07376b",
            "#c9b8f5",
            "#ffe0b8"
          ]
        },
        "primaryForeground": {
          "light": "neutral-2",
          "dark": "neutral-2"
        }
      },
      {
        "id": "atlas-ochre",
        "name": "Ochre",
        "description": "Golden ochre with deep green, cornflower, and soft butter yellow.",
        "colors": {
          "light": [
            "#d4b441",
            "#085e55",
            "#91b9fa",
            "#fff0b8"
          ],
          "dark": [
            "#d4b441",
            "#085e55",
            "#91b9fa",
            "#fff0b8"
          ]
        },
        "primaryForeground": {
          "light": "neutral-9",
          "dark": "neutral-2"
        }
      },
      {
        "id": "atlas-summer",
        "name": "Summer yellow",
        "description": "Sunny yellow grounded by violet and softened with pink and green.",
        "colors": {
          "light": [
            "#ffea00",
            "#5100c0",
            "#ffc0ff",
            "#398574"
          ],
          "dark": [
            "#ffea00",
            "#5100c0",
            "#ffc0ff",
            "#398574"
          ]
        },
        "primaryForeground": {
          "light": "neutral-9",
          "dark": "neutral-2"
        }
      },
      {
        "id": "atlas-kryptonite",
        "name": "Kryptonite",
        "description": "Electric lime with deep green, petal pink, and a cool blue.",
        "colors": {
          "light": [
            "#abff5a",
            "#085e55",
            "#ffc0ff",
            "#80d8e8"
          ],
          "dark": [
            "#abff5a",
            "#085e55",
            "#ffc0ff",
            "#80d8e8"
          ]
        },
        "primaryForeground": {
          "light": "neutral-9",
          "dark": "neutral-2"
        }
      },
      {
        "id": "atlas-leaf",
        "name": "Leaf green",
        "description": "Bright leaf green with violet, soft lilac, and pale yellow.",
        "colors": {
          "light": [
            "#6dcc00",
            "#5100c0",
            "#ddc7ff",
            "#ffed9b"
          ],
          "dark": [
            "#6dcc00",
            "#5100c0",
            "#ddc7ff",
            "#ffed9b"
          ]
        },
        "primaryForeground": {
          "light": "neutral-9",
          "dark": "neutral-2"
        }
      },
      {
        "id": "atlas-fresh",
        "name": "Fresh green",
        "description": "Lively green with deep blue, petal pink, and mint.",
        "colors": {
          "light": [
            "#00c853",
            "#07376b",
            "#ffb8da",
            "#b6ebd8"
          ],
          "dark": [
            "#00c853",
            "#07376b",
            "#ffb8da",
            "#b6ebd8"
          ]
        },
        "primaryForeground": {
          "light": "neutral-10",
          "dark": "neutral-2"
        }
      },
      {
        "id": "atlas-pine",
        "name": "Pine green",
        "description": "Rich green with lime, honey, and a dark blue anchor.",
        "colors": {
          "light": [
            "#00906c",
            "#abff5a",
            "#ffd56a",
            "#123d5c"
          ],
          "dark": [
            "#00906c",
            "#abff5a",
            "#ffd56a",
            "#123d5c"
          ]
        },
        "primaryForeground": {
          "light": "neutral-2",
          "dark": "neutral-2"
        }
      },
      {
        "id": "atlas-deep-green",
        "name": "Deep green",
        "description": "A dark green base with bright orange, mint, and butter yellow.",
        "colors": {
          "light": [
            "#085e55",
            "#ff5a00",
            "#b6ebd8",
            "#ffed9b"
          ],
          "dark": [
            "#085e55",
            "#ff5a00",
            "#b6ebd8",
            "#ffed9b"
          ]
        },
        "primaryForeground": {
          "light": "neutral-2",
          "dark": "neutral-9"
        }
      },
      {
        "id": "atlas-turquoise",
        "name": "Turquoise",
        "description": "Clear turquoise with dark teal, apricot, and pale aqua.",
        "colors": {
          "light": [
            "#00b7c4",
            "#094b58",
            "#ffb579",
            "#c1f3ed"
          ],
          "dark": [
            "#00b7c4",
            "#094b58",
            "#ffb579",
            "#c1f3ed"
          ]
        },
        "primaryForeground": {
          "light": "neutral-2",
          "dark": "neutral-2"
        }
      },
      {
        "id": "atlas-daybreak",
        "name": "Daybreak",
        "description": "Clear cyan with deep blue, pale lilac, and warm orange.",
        "colors": {
          "light": [
            "#00e1f3",
            "#153d85",
            "#c9b8f5",
            "#ff9800"
          ],
          "dark": [
            "#00e1f3",
            "#153d85",
            "#c9b8f5",
            "#ff9800"
          ]
        },
        "primaryForeground": {
          "light": "neutral-9",
          "dark": "neutral-2"
        }
      },
      {
        "id": "atlas-sky",
        "name": "Sky blue",
        "description": "Fresh sky blue with deep green, butter yellow, and soft coral.",
        "colors": {
          "light": [
            "#00afe8",
            "#085e55",
            "#ffed9b",
            "#ffb5aa"
          ],
          "dark": [
            "#00afe8",
            "#085e55",
            "#ffed9b",
            "#ffb5aa"
          ]
        },
        "primaryForeground": {
          "light": "neutral-2",
          "dark": "neutral-2"
        }
      },
      {
        "id": "atlas-azure",
        "name": "Azure",
        "description": "Bright azure with navy, pale lime, and peach.",
        "colors": {
          "light": [
            "#0088ff",
            "#07376b",
            "#d4f5a4",
            "#ffd0b0"
          ],
          "dark": [
            "#0088ff",
            "#07376b",
            "#d4f5a4",
            "#ffd0b0"
          ]
        },
        "primaryForeground": {
          "light": "neutral-2",
          "dark": "neutral-2"
        }
      },
      {
        "id": "atlas-navy",
        "name": "Navy",
        "description": "Deep navy with vivid orange, clear sky, and pale yellow.",
        "colors": {
          "light": [
            "#07376b",
            "#ff5a00",
            "#87d8f5",
            "#ffed9b"
          ],
          "dark": [
            "#07376b",
            "#ff5a00",
            "#87d8f5",
            "#ffed9b"
          ]
        },
        "primaryForeground": {
          "light": "neutral-2",
          "dark": "neutral-9"
        }
      },
      {
        "id": "atlas-monochrome",
        "name": "Monochrome",
        "description": "Soft black, graphite, silver, and chalk.",
        "colors": {
          "light": [
            "#242424",
            "#626262",
            "#b3b3b3",
            "#e5e5e5"
          ],
          "dark": [
            "#242424",
            "#626262",
            "#b3b3b3",
            "#e5e5e5"
          ]
        },
        "primaryForeground": {
          "light": "neutral-2",
          "dark": "neutral-9"
        }
      },
      {
        "id": "atlas-electric",
        "name": "Electric blue",
        "description": "Vivid blue with candy pink, lime, and inky indigo.",
        "colors": {
          "light": [
            "#5151fc",
            "#ffc0ff",
            "#abff5a",
            "#242866"
          ],
          "dark": [
            "#5151fc",
            "#ffc0ff",
            "#abff5a",
            "#242866"
          ]
        },
        "primaryForeground": {
          "light": "neutral-2",
          "dark": "neutral-9"
        }
      },
      {
        "id": "atlas-open-sky",
        "name": "Open sky",
        "description": "Deep violet with coral, soft lilac, and golden yellow.",
        "colors": {
          "light": [
            "#5100c0",
            "#ff7963",
            "#ceb7f5",
            "#ffd260"
          ],
          "dark": [
            "#5100c0",
            "#ff7963",
            "#ceb7f5",
            "#ffd260"
          ]
        },
        "primaryForeground": {
          "light": "neutral-2",
          "dark": "neutral-9"
        }
      },
      {
        "id": "atlas-lavender",
        "name": "Lavender",
        "description": "Bright lavender with deep plum, butter yellow, and pale mint.",
        "colors": {
          "light": [
            "#a34cf3",
            "#4f206d",
            "#ffed9b",
            "#b6ebd8"
          ],
          "dark": [
            "#a34cf3",
            "#4f206d",
            "#ffed9b",
            "#b6ebd8"
          ]
        },
        "primaryForeground": {
          "light": "neutral-2",
          "dark": "neutral-2"
        }
      },
      {
        "id": "atlas-orchid",
        "name": "Orchid",
        "description": "Electric orchid with deep violet, soft lilac, and lime.",
        "colors": {
          "light": [
            "#e82cf2",
            "#5100c0",
            "#e9d5ff",
            "#abff5a"
          ],
          "dark": [
            "#e82cf2",
            "#5100c0",
            "#e9d5ff",
            "#abff5a"
          ]
        },
        "primaryForeground": {
          "light": "neutral-2",
          "dark": "neutral-2"
        }
      },
      {
        "id": "atlas-futuristic",
        "name": "Futuristic pink",
        "description": "Bright pink balanced by deep green, lavender, and apricot.",
        "colors": {
          "light": [
            "#ff6fff",
            "#085e55",
            "#e9d5ff",
            "#ffce9d"
          ],
          "dark": [
            "#ff6fff",
            "#085e55",
            "#e9d5ff",
            "#ffce9d"
          ]
        },
        "primaryForeground": {
          "light": "neutral-2",
          "dark": "neutral-2"
        }
      },
      {
        "id": "atlas-candy",
        "name": "Candy pink",
        "description": "Soft pink with electric blue, dark berry, and peach.",
        "colors": {
          "light": [
            "#ffc0ff",
            "#5151fc",
            "#79094f",
            "#ffd0b0"
          ],
          "dark": [
            "#ffc0ff",
            "#5151fc",
            "#79094f",
            "#ffd0b0"
          ]
        },
        "primaryForeground": {
          "light": "neutral-9",
          "dark": "neutral-2"
        }
      },
      {
        "id": "atlas-hot-pink",
        "name": "Hot pink",
        "description": "Bold pink with deep green, pale lime, and soft peach.",
        "colors": {
          "light": [
            "#ff2c9c",
            "#085e55",
            "#d4f5a4",
            "#ffd0b0"
          ],
          "dark": [
            "#ff2c9c",
            "#085e55",
            "#d4f5a4",
            "#ffd0b0"
          ]
        },
        "primaryForeground": {
          "light": "neutral-2",
          "dark": "neutral-2"
        }
      },
      {
        "id": "atlas-watermelon",
        "name": "Watermelon",
        "description": "Juicy pink-red with navy, mint, and a pale blush.",
        "colors": {
          "light": [
            "#ff2863",
            "#07376b",
            "#b6ebd8",
            "#ffc5ce"
          ],
          "dark": [
            "#ff2863",
            "#07376b",
            "#b6ebd8",
            "#ffc5ce"
          ]
        },
        "primaryForeground": {
          "light": "neutral-2",
          "dark": "neutral-2"
        }
      },
      {
        "id": "atlas-loud",
        "name": "Loud red",
        "description": "A clear red with blush, deep blue, and pale apricot.",
        "colors": {
          "light": [
            "#fc032d",
            "#ffc5ce",
            "#153d85",
            "#ffd7ad"
          ],
          "dark": [
            "#fc032d",
            "#ffc5ce",
            "#153d85",
            "#ffd7ad"
          ]
        },
        "primaryForeground": {
          "light": "neutral-2",
          "dark": "neutral-2"
        }
      }
    ],
    "paletteBaseNeutrals": {
      "light": {
        "neutral-1": "#ffffff",
        "neutral-2": "#fafbfc",
        "neutral-3": "#f2f4f7",
        "neutral-4": "#e4e7eb",
        "neutral-5": "#c8cdd3",
        "neutral-6": "#9ba1aa",
        "neutral-7": "#777e88",
        "neutral-8": "#4f555e",
        "neutral-9": "#2f3339",
        "neutral-10": "#000000"
      },
      "dark": {
        "neutral-1": "#000000",
        "neutral-2": "#1e2024",
        "neutral-3": "#282b30",
        "neutral-4": "#383d44",
        "neutral-5": "#505761",
        "neutral-6": "#7b8490",
        "neutral-7": "#a4acb7",
        "neutral-8": "#c9cfd7",
        "neutral-9": "#f2f4f7",
        "neutral-10": "#ffffff"
      }
    },
    "keyColorPalette": [
      "#ff5a00",
      "#ff9800",
      "#cf9148",
      "#d4b441",
      "#ffea00",
      "#abff5a",
      "#6dcc00",
      "#00c853",
      "#00906c",
      "#085e55",
      "#00b7c4",
      "#00e1f3",
      "#00afe8",
      "#0088ff",
      "#07376b",
      "#242424",
      "#5151fc",
      "#5100c0",
      "#a34cf3",
      "#e82cf2",
      "#ff6fff",
      "#ffc0ff",
      "#ff2c9c",
      "#ff2863",
      "#fc032d"
    ]
  },
  "componentTokens": {
    "button:primary:rest": {
      "paddingTop": "s",
      "paddingBottom": "s",
      "paddingX": "l"
    },
    "button:secondary:rest": {
      "paddingTop": "s",
      "paddingBottom": "s",
      "paddingX": "l"
    },
    "button:outline:rest": {
      "paddingTop": "s",
      "paddingBottom": "s",
      "paddingX": "l"
    },
    "button:ghost:rest": {
      "paddingTop": "s",
      "paddingBottom": "s",
      "paddingX": "l"
    },
    "button:danger:rest": {
      "paddingTop": "s",
      "paddingBottom": "s",
      "paddingX": "l"
    },
    "input:default:rest": {
      "background": "neutral-3",
      "paddingTop": "s",
      "paddingBottom": "s",
      "paddingX": "m"
    },
    "select:default:rest": {
      "background": "neutral-3",
      "paddingTop": "s",
      "paddingBottom": "s",
      "paddingX": "m"
    },
    "combobox:default:rest": {
      "background": "neutral-3",
      "paddingTop": "s",
      "paddingBottom": "s",
      "paddingX": "m"
    },
    "autocomplete:default:part:popover:rest": {
      "radius": "s"
    },
    "autocomplete:default:part:input:rest": {
      "paddingTop": "s",
      "paddingRight": "s",
      "paddingBottom": "s",
      "paddingLeft": "s",
      "paddingX": "s"
    },
    "autocomplete:default:part:option:selected": {
      "paddingTop": "xs",
      "paddingRight": "xs",
      "paddingBottom": "xs",
      "paddingLeft": "xs",
      "paddingX": "xs"
    },
    "autocomplete:default:part:option:rest": {
      "paddingTop": "xs",
      "paddingRight": "xs",
      "paddingBottom": "xs",
      "paddingLeft": "xs",
      "paddingX": "xs"
    },
    "checkbox:default:part:control:rest": {
      "controlSize": "l"
    },
    "combobox:default:part:option:selected": {
      "paddingTop": "xs",
      "paddingRight": "xs",
      "paddingBottom": "xs",
      "paddingLeft": "xs",
      "paddingX": "xs"
    },
    "combobox:default:part:option:rest": {
      "paddingTop": "xs",
      "paddingRight": "xs",
      "paddingBottom": "xs",
      "paddingLeft": "xs",
      "paddingX": "xs"
    },
    "menu:default:part:option:selected": {
      "paddingTop": "xs",
      "paddingRight": "xs",
      "paddingBottom": "xs",
      "paddingLeft": "xs",
      "paddingX": "xs"
    },
    "menu:default:part:option:rest": {
      "paddingTop": "xs",
      "paddingRight": "xs",
      "paddingBottom": "xs",
      "paddingLeft": "xs",
      "paddingX": "xs"
    },
    "otp-field:default:part:input:rest": {
      "paddingTop": "xs",
      "paddingRight": "s",
      "paddingBottom": "xs",
      "paddingLeft": "s",
      "paddingX": "s"
    },
    "slider:default:part:track:rest": {
      "controlSize": "xl"
    },
    "slider:default:part:thumb:rest": {
      "controlSize": "l"
    },
    "switch:default:part:control:rest": {
      "controlSize": "xl"
    }
  },
  "componentVariants": {}
};

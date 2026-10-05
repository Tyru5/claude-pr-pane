export type AsciiRenderOptions = {
  useAscii?: boolean
  paddingX?: number
  paddingY?: number
  boxBorderPadding?: number
  colorMode?: 'none' | 'auto' | 'ansi16' | 'ansi256' | 'truecolor' | 'html'
}

/** Mermaid source to Unicode box-drawing text; throws on what it cannot parse. */
export declare function renderMermaidASCII(text: string, options?: AsciiRenderOptions): string

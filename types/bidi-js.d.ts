declare module "bidi-js" {
  interface BidiParagraph {
    start: number;
    end: number;
    level: number;
  }

  interface BidiEmbeddingLevels {
    levels: Uint8Array;
    paragraphs: BidiParagraph[];
  }

  interface Bidi {
    getEmbeddingLevels(text: string, baseDirection?: "ltr" | "rtl"): BidiEmbeddingLevels;
  }

  export default function bidiFactory(): Bidi;
}

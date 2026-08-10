/** Compact README-style icons (width ≤ 96). CSS uses data-note-img-size instead of :has(). */
export const NOTE_SMALL_IMAGE_MAX_WIDTH = 96;

export const isNoteSmallImageWidth = (widthRaw: string | number | null | undefined): boolean => {
  const width = typeof widthRaw === "number" ? widthRaw : Number(String(widthRaw ?? "").trim());
  return Number.isFinite(width) && width > 0 && width <= NOTE_SMALL_IMAGE_MAX_WIDTH;
};

/**
 * Mark compact images so CSS can lay out badge rows without hundreds of :has()
 * width selectors. Also enable lazy loading for remote images.
 */
export const annotateNoteImageSizes = (container: HTMLElement): void => {
  container.querySelectorAll("img").forEach((node) => {
    if (!(node instanceof HTMLImageElement)) return;
    const isSmall = isNoteSmallImageWidth(node.getAttribute("width"));

    if (isSmall) {
      node.dataset.noteImgSize = "sm";
    } else {
      delete node.dataset.noteImgSize;
    }

    // Prefer browser-native lazy decode for remote screenshots / badges.
    if (node.getAttribute("src") && !node.getAttribute("loading")) {
      node.loading = "lazy";
    }
    if (!node.getAttribute("decoding")) {
      node.decoding = "async";
    }

    const wrappers: HTMLElement[] = [];
    const block = node.closest<HTMLElement>("[data-editor-block-type=\"image\"]");
    if (block) wrappers.push(block);
    const imageWrapper = node.closest<HTMLElement>("[class*=\"_imageWrapper_\"]");
    if (imageWrapper && imageWrapper !== block) wrappers.push(imageWrapper);
    const parent = node.parentElement;
    if (parent?.tagName === "P" && parent.childElementCount === 1) {
      wrappers.push(parent);
    }

    for (const wrapper of wrappers) {
      if (isSmall) wrapper.dataset.noteImgSize = "sm";
      else delete wrapper.dataset.noteImgSize;
    }
  });
};

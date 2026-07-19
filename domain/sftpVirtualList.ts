interface SftpVirtualListScrollInput {
  itemIndex: number;
  rowHeight: number;
  currentScrollTop: number;
  viewportHeight: number;
}

export const getSftpVirtualListScrollTop = ({
  itemIndex,
  rowHeight,
  currentScrollTop,
  viewportHeight,
}: SftpVirtualListScrollInput): number => {
  const rowTop = itemIndex * rowHeight;
  const rowBottom = rowTop + rowHeight;

  if (rowTop < currentScrollTop) return rowTop;
  if (rowBottom > currentScrollTop + viewportHeight) {
    return rowBottom - viewportHeight;
  }
  return currentScrollTop;
};

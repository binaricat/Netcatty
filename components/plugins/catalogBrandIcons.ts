import previews from './catalog-brand-icons.json';

/** Only bundled reviewed assets; catalog data never becomes an image URL. */
export function resolveCatalogBrandIcon(entry: NetcattyPluginCatalogEntry): { light: string; dark?: string } | null {
  const preview = previews.find((item) => item.id === entry.id && item.version === entry.version
    && item.repository === entry.repository && item.commit === entry.commit
    && JSON.stringify(item.icon) === JSON.stringify(entry.manifest.icon));
  return preview ? { light: preview.light, dark: preview.dark } : null;
}

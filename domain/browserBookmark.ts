export interface BrowserBookmark {
  id: string;
  title: string;
  url: string;
  scope: 'host' | 'all-hosts';
  hostId: string | null;
  icon: string;
  iconMode?: 'auto' | 'custom';
  iconDataUrl?: string | null;
  color: string;
  order: number;
  createdAt: number;
  updatedAt: number;
}

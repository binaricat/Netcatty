import { toast } from '../ui/toast';

/** Surface action failures as a global toast instead of inline panel banners. */
export function showSystemManagerError(message: string, title?: string) {
  toast.error(message, title);
}

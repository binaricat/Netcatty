const safeParse = <T>(value: string | null): T | null => {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
};

export const localStorageAdapter = {
  read<T>(key: string): T | null {
    return safeParse<T>(localStorage.getItem(key));
  },
  write<T>(key: string, value: T) {
    localStorage.setItem(key, JSON.stringify(value));
  },
  readString(key: string): string | null {
    return localStorage.getItem(key);
  },
  writeString(key: string, value: string) {
    localStorage.setItem(key, value);
  },
  remove(key: string) {
    localStorage.removeItem(key);
  },
};

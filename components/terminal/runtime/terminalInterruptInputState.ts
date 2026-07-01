type StringRef = {
  current: string;
};

type InterruptInputStateOptions = {
  commandBufferRef: StringRef;
  serialLineBufferRef?: StringRef;
  onAutocompleteInput?: (data: string) => void;
};

export function clearTerminalInputStateForInterrupt({
  commandBufferRef,
  serialLineBufferRef,
  onAutocompleteInput,
}: InterruptInputStateOptions): void {
  commandBufferRef.current = "";
  if (serialLineBufferRef) {
    serialLineBufferRef.current = "";
  }
  onAutocompleteInput?.("\x03");
}

import React from 'react';
import { Folder, Loader2 } from 'lucide-react';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import { Input } from '../ui/input';
import { cn } from '../../lib/utils';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SftpMoveToDialogProps = Record<string, any>;

export const SftpMoveToDialog: React.FC<SftpMoveToDialogProps> = ({
  showMoveToDialog, setShowMoveToDialog, setMoveToPath, setMoveToError, setMoveToSuggestions,
  setMoveToSuggestionIndex, t, moveToInputRef, moveToPath, fetchMoveToSuggestions,
  moveToSuggestions, moveToSuggestionIndex, moveToError, isMoving, handleMoveToSubmit,
}) => (
      <Dialog open={showMoveToDialog} onOpenChange={(open) => {
        if (!open) {
          setShowMoveToDialog(false);
          setMoveToSuggestions([]);
          setMoveToSuggestionIndex(-1);
        }
      }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('sftp.moveTo.title')}</DialogTitle>
          </DialogHeader>
          <div className="relative">
            <Input
              ref={moveToInputRef}
              value={moveToPath}
              onChange={(e) => {
                const val = e.target.value;
                setMoveToPath(val);
                setMoveToError(null);
                setMoveToSuggestionIndex(-1);
                fetchMoveToSuggestions(val);
              }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown' && moveToSuggestions.length > 0) {
                  e.preventDefault();
                  setMoveToSuggestionIndex((i) => i < moveToSuggestions.length - 1 ? i + 1 : 0);
                } else if (e.key === 'ArrowUp' && moveToSuggestions.length > 0) {
                  e.preventDefault();
                  setMoveToSuggestionIndex((i) => i > 0 ? i - 1 : moveToSuggestions.length - 1);
                } else if (e.key === 'Tab' && moveToSuggestionIndex >= 0) {
                  e.preventDefault();
                  const selected = moveToSuggestions[moveToSuggestionIndex];
                  setMoveToPath(selected);
                  setMoveToError(null);
                  fetchMoveToSuggestions(selected);
                } else if (e.key === 'Enter') {
                  e.preventDefault();
                  if (moveToSuggestionIndex >= 0 && moveToSuggestions[moveToSuggestionIndex]) {
                    const selected = moveToSuggestions[moveToSuggestionIndex];
                    setMoveToPath(selected);
                    setMoveToSuggestionIndex(-1);
                    setMoveToSuggestions([]);
                    setMoveToError(null);
                  } else {
                    void handleMoveToSubmit();
                  }
                } else if (e.key === 'Escape') {
                  if (moveToSuggestions.length > 0) {
                    e.preventDefault();
                    e.stopPropagation();
                    setMoveToSuggestions([]);
                    setMoveToSuggestionIndex(-1);
                  }
                  // When no suggestions, let the Dialog handle ESC to close itself
                }
              }}
              placeholder={t('sftp.moveTo.placeholder')}
              autoFocus
              className={moveToError ? 'border-destructive' : undefined}
            />
            {moveToSuggestions.length > 0 && (
              <div className="absolute left-0 right-0 top-full mt-1 z-50 rounded-md border bg-popover shadow-md max-h-48 overflow-y-auto">
                {moveToSuggestions.map((suggestion, i) => (
                  <div
                    key={suggestion}
                    className={cn(
                      'px-3 py-1.5 text-sm cursor-pointer truncate',
                      i === moveToSuggestionIndex ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50',
                    )}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      setMoveToPath(suggestion);
                      setMoveToSuggestions([]);
                      setMoveToSuggestionIndex(-1);
                      setMoveToError(null);
                    }}
                  >
                    <Folder size={12} className="inline mr-2 text-yellow-500" />
                    {suggestion}
                  </div>
                ))}
              </div>
            )}
          </div>
          {moveToError && (
            <p className="text-xs text-destructive">{moveToError}</p>
          )}
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setShowMoveToDialog(false)}>
              {t('common.cancel')}
            </Button>
            <Button size="sm" disabled={!moveToPath.trim() || isMoving} onClick={() => void handleMoveToSubmit()}>
              {isMoving && <Loader2 size={14} className="mr-2 animate-spin" />}
              {t('sftp.moveTo.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
);

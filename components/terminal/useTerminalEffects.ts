/* eslint-disable @typescript-eslint/no-explicit-any, react-hooks/exhaustive-deps */

type TerminalEffectsContext = Record<string, any>;

export function useTerminalEffects(ctx: TerminalEffectsContext) {
  const { CONNECTION_TIMEOUT, Error, XTERM_PERFORMANCE_CONFIG, applyUserCursorPreference, auth, autocompleteCloseRef, autocompleteInputRef, autocompleteKeyEventRef, captureTerminalLogData, clearTerminalCwd, commandBufferRef, connectionLogBufferRef, containerRef, createPromptLineBreakState, createReplaySafeTerminalLogSanitizer, createXTermRuntime, effectiveFontSize, effectiveFontWeight, effectiveTheme, error, executeSnippetCommand, fitAddonRef, fontFamilyId, fontSize, fontWeightFixupDoneRef, forceSyncRenderAfterResize, handleOsc52ReadRequest, handleTerminalDataCaptureOnce, hasConnectedRef, host, hotkeySchemeRef, identities, inWorkspace, isBroadcastEnabledRef, isFocusMode, isFocused, isLocalConnection, isNetworkDevice, isResizing, isRestoringSelectionRef, isSearchOpen, isSerialConnection, isVisible, isVisibleRef, keyBindingsRef, keys, knownCwdRef, lastFittedSizeRef, lastToastedErrorRef, logger, mouseTrackingRef, onBroadcastInputRef, onCommandExecuted, onHotkeyActionRef, onSnippetExecutorChange, onTerminalCwdChange, onTerminalFontSizeChange, pendingAuthRef, pendingOutputScrollRef, prevIsResizingRef, primaryFontFamily, promptLineBreakStateRef, resizeSession, resolveHostAuth, resolvedFontFamily, safeFit, searchAddonRef, serialConfig, serialLineBufferRef, serializeAddonRef, sessionId, sessionRef, sessionStarters, setError, setHasMouseTracking, setHasSelection, setIsCancelling, setIsDisconnectedDialogDismissed, setIsSearchOpen, setNeedsHostKeyVerification, setPendingHostKeyInfo, setPendingHostKeyRequestId, setProgressLogs, setProgressValue, setShowLogs, setStatus, setTimeLeft, shouldEnableNativeUserInputAutoScroll, shouldProbeSessionCwd, onSnippetShortkeyRef, snippetsRef, status, statusRef, t, teardown, termRef, terminalAltKeyOptions, terminalBackend, terminalContextActionsRef, terminalCwdTracker, terminalDataCapturedRef, terminalLogSanitizerRef, terminalSettings, terminalSettingsRef, toHostKeyInfo, toast, updateStatus, useEffect, useLayoutEffect, xtermRuntimeRef, zmodem, zmodemToastedRef } = ctx;


  useEffect(() => {
    if (xtermRuntimeRef.current) {
      // Merge global rules with host-level rules
      const globalRules = terminalSettings?.keywordHighlightRules ?? [];
      const hostRules = host?.keywordHighlightRules ?? [];

      const globalEnabled = terminalSettings?.keywordHighlightEnabled ?? false;
      // Host-level toggle: undefined = inherit global, true/false = explicit override
      const hostEnabled = host?.keywordHighlightEnabled;

      // Global and host-level highlights are independent:
      // global toggle controls global rules, host toggle controls host-specific rules
      const effectiveGlobalEnabled = globalEnabled;
      const effectiveHostEnabled = hostEnabled ?? false;

      const mergedRules = [
        ...(effectiveGlobalEnabled ? globalRules : []),
        ...(effectiveHostEnabled ? hostRules : [])
      ];
      const isEnabled = effectiveGlobalEnabled || effectiveHostEnabled;

      xtermRuntimeRef.current.keywordHighlighter.setRules(mergedRules, isEnabled);
    }
  }, [
    terminalSettings?.keywordHighlightEnabled,
    terminalSettings?.keywordHighlightRules,
    host?.keywordHighlightEnabled,
    host?.keywordHighlightRules
  ]);


  // Work around xterm.js WebGL renderer bug: glyphs rendered via the constructor
  // look different from dynamically-set ones. After text appears on screen (status
  // becomes "connected"), do a fontWeight round-trip to normalize the rendering.
  useEffect(() => {
    if (status !== 'connected' || fontWeightFixupDoneRef.current || !termRef.current) return;
    fontWeightFixupDoneRef.current = true;
    const timer = setTimeout(() => {
      if (!termRef.current) return;
      // Re-read the current weight at fire time to avoid stale closures
      const w = termRef.current.options.fontWeight;
      if (w === 'normal' || w === 400) return;
      termRef.current.options.fontWeight = 'normal';
      termRef.current.options.fontWeight = w;
    }, 200);
    return () => clearTimeout(timer);
  }, [status]);


  useEffect(() => {
    clearTerminalCwd();
    return clearTerminalCwd;
  }, [clearTerminalCwd, host.id]);


  useEffect(() => {
    if (host.protocol === "local" || host.protocol === "serial" || host.protocol === "telnet") {
      return;
    }
    if (status !== "connected" || !sessionRef.current || knownCwdRef.current) return;

    let cancelled = false;
    const timer = setTimeout(async () => {
      const id = sessionRef.current;
      if (!id) return;
      try {
        // The pwd probe opens an extra POSIX-shell exec channel, which strict
        // network-device CLIs like Huawei VRP answer by closing the whole
        // session (#1043). Skip it for known network devices; for a brand-new
        // host (distro not classified yet on the first connect) consult the
        // SSH banner, which is captured for free at handshake time.
        const info = await terminalBackend.getSessionRemoteInfo?.(id);
        if (cancelled || id !== sessionRef.current) return;
        if (!shouldProbeSessionCwd({ isNetworkDevice, remoteSshVersion: info?.remoteSshVersion })) {
          return;
        }
        const result = await terminalBackend.getSessionPwd(id);
        if (!cancelled && !terminalCwdTracker.getRendererCwd() && result.success && result.cwd) {
          knownCwdRef.current = result.cwd;
        }
      } catch {
        // Best effort only.
      }
    }, 150);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [host.protocol, status, terminalBackend, terminalCwdTracker, isNetworkDevice]);


  useEffect(() => {
    if (!isVisible) {
      autocompleteCloseRef.current?.();
    }
  }, [isVisible]);

  useEffect(() => {
    if (zmodem.active) {
      zmodemToastedRef.current = false;
      return;
    }
    if (zmodemToastedRef.current) return;
    if (zmodem.error) {
      zmodemToastedRef.current = true;
      toast.error(zmodem.error, 'ZMODEM');
    } else if (zmodem.filename) {
      zmodemToastedRef.current = true;
      toast.success(
        `${zmodem.transferType === 'upload' ? 'Uploaded' : 'Downloaded'}: ${zmodem.filename}`,
        'ZMODEM',
      );
    }
  }, [zmodem.active, zmodem.error, zmodem.filename, zmodem.transferType]);


  useEffect(() => {
    if (!error) {
      lastToastedErrorRef.current = null;
      return;
    }
    if (lastToastedErrorRef.current === error) return;
    lastToastedErrorRef.current = error;
    toast.error(error, t("terminal.connectionErrorTitle"));
  }, [error, t]);


  useEffect(() => {
    const dispose = terminalBackend.onHostKeyVerification?.((request) => {
      if (request.sessionId !== sessionId) return;

      setPendingHostKeyRequestId(request.requestId);
      setPendingHostKeyInfo(toHostKeyInfo(request));
      setNeedsHostKeyVerification(true);
      setError(null);
      setProgressLogs((prev) => [
        ...prev,
        request.status === 'changed'
          ? `Host key changed for ${request.hostname}. Waiting for confirmation...`
          : `Host key verification required for ${request.hostname}.`,
      ]);
    });

    return () => {
      dispose?.();
    };
  }, [sessionId, terminalBackend]);


  useEffect(() => {
    let disposed = false;
    terminalDataCapturedRef.current = false;
    connectionLogBufferRef.current.reset();
    terminalLogSanitizerRef.current = createReplaySafeTerminalLogSanitizer();
    setError(null);
    hasConnectedRef.current = false;
    pendingOutputScrollRef.current = false;
    setProgressLogs([]);
    setShowLogs(false);
    setIsCancelling(false);
    setIsDisconnectedDialogDismissed(false);
    promptLineBreakStateRef.current = createPromptLineBreakState();

    const boot = async () => {
      try {
        if (disposed || !containerRef.current) return;

        const runtime = createXTermRuntime({
          container: containerRef.current,
          host,
          fontFamilyId,
          fontSize,
          terminalTheme: effectiveTheme,
          terminalSettingsRef,
          terminalBackend,
          sessionRef,
          hotkeySchemeRef,
          keyBindingsRef,
          onHotkeyActionRef,
          onTerminalFontSizeChange,
          isBroadcastEnabledRef,
          onBroadcastInputRef,
          snippetsRef,
          onSnippetShortkeyRef,
          sessionId,
          statusRef,
          onCommandExecuted,
          commandBufferRef,
          promptLineBreakStateRef,
          setIsSearchOpen,
          // Serial-specific options
          serialLocalEcho: serialConfig?.localEcho,
          serialLineMode: serialConfig?.lineMode,
          serialLineBufferRef,
          onTerminalLogData: captureTerminalLogData,
          onCwdChange: (cwd: string) => {
            terminalCwdTracker.setRendererCwd(cwd);
            knownCwdRef.current = cwd;
            onTerminalCwdChange?.(sessionId, cwd);
          },
          onOsc52ReadRequest: handleOsc52ReadRequest,
          // Autocomplete integration
          onAutocompleteKeyEvent: (e: KeyboardEvent) => autocompleteKeyEventRef.current?.(e) ?? true,
          onAutocompleteInput: (data: string) => autocompleteInputRef.current?.(data),
          isRestoringSelectionRef,
        });

        xtermRuntimeRef.current = runtime;
        termRef.current = runtime.term;
        fitAddonRef.current = runtime.fitAddon;
        serializeAddonRef.current = runtime.serializeAddon;
        searchAddonRef.current = runtime.searchAddon;

        // Apply merged keyword highlight rules immediately after runtime creation
        // This fixes a timing issue where the useEffect for keyword highlighting
        // runs before the runtime is created, causing host-level rules to be missed
        const globalRules = terminalSettingsRef.current?.keywordHighlightRules ?? [];
        const hostRules = host?.keywordHighlightRules ?? [];
        const globalEnabled = terminalSettingsRef.current?.keywordHighlightEnabled ?? false;
        const hostEnabled = host?.keywordHighlightEnabled;
        const effectiveGlobalEnabled = globalEnabled;
        const effectiveHostEnabled = hostEnabled ?? false;
        const mergedRules = [
          ...(effectiveGlobalEnabled ? globalRules : []),
          ...(effectiveHostEnabled ? hostRules : [])
        ];
        const isEnabled = effectiveGlobalEnabled || effectiveHostEnabled;
        runtime.keywordHighlighter.setRules(mergedRules, isEnabled);

        const term = runtime.term;

        if (host.protocol === "serial") {
          setStatus("connecting");
          setProgressLogs(["Initializing serial connection..."]);
          await sessionStarters.startSerial(term);
        } else if (host.protocol === "local" || host.hostname === "localhost") {
          setStatus("connecting");
          setProgressLogs(["Initializing local shell..."]);
          await sessionStarters.startLocal(term);
        } else if (host.protocol === "telnet") {
          setStatus("connecting");
          setProgressLogs(["Initializing Telnet connection..."]);
          await sessionStarters.startTelnet(term);
        } else if (host.moshEnabled) {
          setStatus("connecting");
          setProgressLogs(["Initializing Mosh connection..."]);
          await sessionStarters.startMosh(term);
        } else if (host.etEnabled) {
          setStatus("connecting");
          setProgressLogs(["Initializing EternalTerminal connection..."]);
          await sessionStarters.startEt(term);
        } else {
          const resolvedAuth = resolveHostAuth({ host, keys, identities });
          const hasPassword = !!resolvedAuth.password;
          const hasKey = !!resolvedAuth.keyId;
          const hasPendingAuth = pendingAuthRef.current;

          if (
            !hasPassword &&
            !hasKey &&
            !hasPendingAuth &&
            !resolvedAuth.username
          ) {
            auth.setNeedsAuth(true);
            setStatus("disconnected");
            return;
          }

          setStatus("connecting");
          setProgressLogs(["Initializing secure channel..."]);
          await sessionStarters.startSSH(term);
        }
      } catch (err) {
        logger.error("Failed to initialize terminal", err);
        setError(err instanceof Error ? err.message : String(err));
        updateStatus("disconnected");
      }
    };

    boot();

    return () => {
      disposed = true;
      if (!terminalDataCapturedRef.current && serializeAddonRef.current) {
        try {
          const terminalData = serializeAddonRef.current.serialize();
          logger.info("[Terminal] Capturing data on unmount", { sessionId, dataLength: terminalData.length });
          handleTerminalDataCaptureOnce(sessionId, terminalData);
        } catch (err) {
          logger.warn("Failed to serialize terminal data on unmount:", err);
        }
      }
      teardown();
    };
     
  }, [handleTerminalDataCaptureOnce, host.id, sessionId]);


  // Connection timeline and timeout visuals
  useEffect(() => {
    if (status !== "connecting" || auth.needsAuth) return;

    // Local terminal and serial connections don't need timeout/progress UI
    if (isLocalConnection || isSerialConnection) return;

    setTimeLeft(CONNECTION_TIMEOUT / 1000);
    const countdown = setInterval(() => {
      setTimeLeft((prev) => (prev > 0 ? prev - 1 : 0));
    }, 1000);

    const timeout = setTimeout(() => {
      setError("Connection timed out. Please try again.");
      updateStatus("disconnected");
      setProgressLogs((prev) => [...prev, "Connection timed out."]);
    }, CONNECTION_TIMEOUT);

    setProgressValue(5);
    const prog = setInterval(() => {
      setProgressValue((prev) => {
        if (prev >= 95) return prev;
        const remaining = 95 - prev;
        const increment = Math.max(1, remaining * 0.15);
        return Math.min(95, prev + increment);
      });
    }, 200);

    return () => {
      clearInterval(countdown);
      clearTimeout(timeout);
      clearInterval(prog);
    };
     
  }, [status, auth.needsAuth, host.protocol, host.hostname]);


  useEffect(() => {
    if (status === "connecting") {
      setIsDisconnectedDialogDismissed(false);
    }
  }, [status]);


  // Sync xterm theme before browser paint so canvas + DOM CSS vars update in the same frame
  useLayoutEffect(() => {
    if (termRef.current) {
      termRef.current.options.theme = {
        ...effectiveTheme.colors,
        selectionBackground: effectiveTheme.colors.selection,
        scrollbarSliderBackground: effectiveTheme.colors.foreground + '33',
        scrollbarSliderHoverBackground: effectiveTheme.colors.foreground + '66',
        scrollbarSliderActiveBackground: effectiveTheme.colors.foreground + '80',
      };
    }
  }, [effectiveTheme]);


  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.fontSize = effectiveFontSize;
      termRef.current.options.fontFamily = resolvedFontFamily;

      if (terminalSettings) {
        applyUserCursorPreference(termRef.current, terminalSettings);
        termRef.current.options.scrollback = terminalSettings.scrollback === 0 ? 999999 : terminalSettings.scrollback;
        termRef.current.options.fontWeight = effectiveFontWeight as
          | 100
          | 200
          | 300
          | 400
          | 500
          | 600
          | 700
          | 800
          | 900;
        const resolvedFontWeightBold = (() => {
          const fontFamily = termRef.current?.options.fontFamily || "";
          if (typeof document === "undefined" || !document.fonts?.check) {
            return terminalSettings.fontWeightBold;
          }
          const weightSpec = `${terminalSettings.fontWeightBold} ${effectiveFontSize}px ${primaryFontFamily(fontFamily)}`;
          return document.fonts.check(weightSpec)
            ? terminalSettings.fontWeightBold
            : effectiveFontWeight;
        })();

        termRef.current.options.fontWeightBold = resolvedFontWeightBold as
          | 100
          | 200
          | 300
          | 400
          | 500
          | 600
          | 700
          | 800
          | 900;
        termRef.current.options.lineHeight = 1 + terminalSettings.linePadding / 10;
        termRef.current.options.drawBoldTextInBrightColors =
          terminalSettings.drawBoldInBrightColors;
        termRef.current.options.minimumContrastRatio =
          terminalSettings.minimumContrastRatio;
        termRef.current.options.smoothScrollDuration =
          terminalSettings.smoothScrolling
            ? XTERM_PERFORMANCE_CONFIG.rendering.smoothScrollDuration
            : 0;
        termRef.current.options.scrollOnUserInput =
          shouldEnableNativeUserInputAutoScroll(terminalSettings);
        const altKeyOpts = terminalAltKeyOptions(terminalSettings.altAsMeta);
        termRef.current.options.macOptionIsMeta = altKeyOpts.macOptionIsMeta;
        termRef.current.options.altClickMovesCursor = altKeyOpts.altClickMovesCursor;
        termRef.current.options.wordSeparator = terminalSettings.wordSeparators;
        termRef.current.options.ignoreBracketedPasteMode = terminalSettings.disableBracketedPaste ?? false;
      }

      // Changing the font can leave the WebGL renderer drawing stale glyphs from
      // the old metrics (xterm.js #3280), surfacing as garbled text (issue #1049).
      // Clear the texture atlas so glyphs re-rasterize with the new font.
      xtermRuntimeRef.current?.clearTextureAtlas();

      if (isVisibleRef.current) {
        setTimeout(() => safeFit({ force: true, requireVisible: true }), 50);
      } else {
        lastFittedSizeRef.current = null;
      }
    }
  }, [effectiveFontSize, effectiveFontWeight, resolvedFontFamily, terminalSettings]);


  useEffect(() => {
    if (!isVisible) return;
    const timer = setTimeout(() => {
      safeFit({ requireVisible: true });
      // Recover the WebGL renderer now that this tab is visible again. Hidden
      // panes stay mounted off-screen (visibility:hidden) so each keeps a live
      // WebGL context; creating another terminal's context — or the GPU dropping
      // a non-composited off-screen canvas — can leave this terminal's drawing
      // buffer corrupted ("花屏", issue #1063). Because a hidden pane keeps its
      // dimensions, becoming visible triggers no resize and therefore no redraw,
      // so the corruption persists until the user resizes the window. Force the
      // same recovery a resize performs: clear the texture atlas (no-op on the
      // DOM renderer) and synchronously repaint every row.
      xtermRuntimeRef.current?.clearTextureAtlas();
      const visibleTerm = termRef.current;
      if (visibleTerm) forceSyncRenderAfterResize(visibleTerm);
      if (pendingOutputScrollRef.current) {
        termRef.current?.scrollToBottom();
        if (typeof requestAnimationFrame === "function") {
          requestAnimationFrame(() => {
            termRef.current?.scrollToBottom();
          });
        }
        pendingOutputScrollRef.current = false;
      }
    }, 50);
    return () => clearTimeout(timer);
  }, [isVisible]);


  useEffect(() => {
    let cancelled = false;
    const waitForFonts = async () => {
      try {
        const fontFaceSet = document.fonts as FontFaceSet | undefined;
        if (!fontFaceSet?.ready) return;
        await fontFaceSet.ready;
        if (cancelled) return;

        const term = termRef.current as {
          cols: number;
          rows: number;
          renderer?: { remeasureFont?: () => void };
        } | null;
        const fitAddon = fitAddonRef.current;
        try {
          term?.renderer?.remeasureFont?.();
        } catch (err) {
          logger.warn("Font remeasure failed", err);
        }

        try {
          fitAddon?.fit();
        } catch (err) {
          logger.warn("Fit after fonts ready failed", err);
        }

        if (terminalSettings && termRef.current) {
          const fontFamily = termRef.current.options?.fontFamily || "";
          if (typeof document !== "undefined" && document.fonts?.check) {
            const weightSpec = `${terminalSettings.fontWeightBold} ${effectiveFontSize}px ${primaryFontFamily(fontFamily)}`;
            const resolvedBold = document.fonts.check(weightSpec)
              ? terminalSettings.fontWeightBold
              : effectiveFontWeight;
            termRef.current.options.fontWeightBold = resolvedBold as
              | 100
              | 200
              | 300
              | 400
              | 500
              | 600
              | 700
              | 800
              | 900;
          }
        }

        const id = sessionRef.current;
        if (id && term) {
          try {
            resizeSession(id, term.cols, term.rows);
          } catch (err) {
            logger.warn("Resize session after fonts ready failed", err);
          }
        }
      } catch (err) {
        logger.warn("Waiting for fonts failed", err);
      }
    };

    waitForFonts();
    return () => {
      cancelled = true;
    };
  }, [effectiveFontSize, effectiveFontWeight, resizeSession, terminalSettings]);


  useEffect(() => {
    if (!isVisible || !containerRef.current || !fitAddonRef.current) return;

    let resizeTimeout: ReturnType<typeof setTimeout> | null = null;

    const observer = new ResizeObserver(() => {
      if (isResizing || !isVisibleRef.current) return;
      if (resizeTimeout) {
        clearTimeout(resizeTimeout);
      }
      resizeTimeout = setTimeout(() => {
        safeFit({ requireVisible: true });
      }, 250);
    });

    observer.observe(containerRef.current);
    return () => {
      if (resizeTimeout) clearTimeout(resizeTimeout);
      observer.disconnect();
    };
  }, [isVisible, isResizing]);

  useEffect(() => {
    if (prevIsResizingRef.current && !isResizing && isVisible) {
      const timer = setTimeout(() => {
        safeFit({ force: true, requireVisible: true });
      }, 100);
      return () => clearTimeout(timer);
    }
    prevIsResizingRef.current = isResizing;
  }, [isResizing, isVisible]);


  useEffect(() => {
    if (!isVisible || !fitAddonRef.current) return;
    // Fit twice: once after initial layout (100ms) and again after layout settles
    // (350ms) to handle race conditions during split operations where the container
    // dimensions may not be final on the first pass.
    const timer1 = setTimeout(() => {
      safeFit({ requireVisible: true });
    }, 100);
    const timer2 = setTimeout(() => {
      safeFit({ force: true, requireVisible: true });
    }, 350);
    return () => { clearTimeout(timer1); clearTimeout(timer2); };
  }, [inWorkspace, isVisible]);


  // When search bar opens/closes, re-fit terminal and maintain scroll position
  useEffect(() => {
    const term = termRef.current;
    if (!term || !fitAddonRef.current) return;
    const buffer = term.buffer.active;
    const wasAtBottom = buffer.viewportY >= buffer.baseY;
    const prevViewportY = buffer.viewportY;
    const timer = setTimeout(() => {
      safeFit({ force: true, requireVisible: true });
      requestAnimationFrame(() => {
        if (wasAtBottom) {
          term.scrollToBottom();
        } else {
          term.scrollToLine(prevViewportY);
        }
      });
    }, 0);
    return () => clearTimeout(timer);
  }, [isSearchOpen]);


  useEffect(() => {
    const shouldAutoFocus = isVisible && termRef.current && (!inWorkspace || isFocusMode);
    if (shouldAutoFocus) {
      const timer = setTimeout(() => {
        termRef.current?.focus();
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [isVisible, inWorkspace, isFocusMode]);


  useEffect(() => {
    if (isFocused && termRef.current && isVisible) {
      const timer = setTimeout(() => {
        termRef.current?.focus();
      }, 10);
      return () => clearTimeout(timer);
    }
  }, [isFocused, isVisible, sessionId]);


  useEffect(() => {
    const term = termRef.current;
    if (!term) return;

    const onSelectionChange = () => {
      const selection = term.getSelection();
      const hasText = !!selection && selection.length > 0;
      setHasSelection(hasText);

      if (hasText && terminalSettings?.copyOnSelect && !isRestoringSelectionRef.current) {
        navigator.clipboard.writeText(selection).catch((err) => {
          logger.warn("Copy on select failed:", err);
        });
      }
    };

    const disposable = term.onSelectionChange(onSelectionChange);
    return () => disposable.dispose();
  }, [terminalSettings?.copyOnSelect]);


  // Track whether the terminal application has enabled mouse tracking
  // (e.g. tmux with `set -g mouse on`, vim with `set mouse=a`).
  // When mouse tracking is active, disable Netcatty's context menu to avoid
  // conflicting with the application's own mouse handling.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;

    const disposable = term.onWriteParsed(() => {
      const tracking = term.modes.mouseTrackingMode !== 'none';
      if (tracking !== mouseTrackingRef.current) {
        mouseTrackingRef.current = tracking;
        setHasMouseTracking(tracking);
      }
    });

    // Set initial state
    const initial = term.modes.mouseTrackingMode !== 'none';
    mouseTrackingRef.current = initial;
    setHasMouseTracking(initial);

    return () => disposable.dispose();
  }, [sessionId]);


  // Prevent xterm.js's built-in rightClickHandler and right-button mouseup
  // from interfering with tmux/vim popup menus when mouse tracking is active.
  // - contextmenu: xterm.js calls textarea.select() which steals focus
  // - mouseup (button 2): tmux interprets the right-button release as a
  //   dismiss action, closing the popup menu immediately after it appears
  // Both are intercepted at the capture phase before xterm.js's own listeners.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const handleContextMenuCapture = (e: MouseEvent) => {
      if (!mouseTrackingRef.current) return;
      if (statusRef.current !== 'connected') return;
      e.preventDefault();
      e.stopImmediatePropagation();

      // stopImmediatePropagation blocks the event from reaching React's
      // bubble-phase root listener, so the onContextMenu handler in
      // TerminalContextMenu (which dispatches paste / select-word) never
      // fires inside a mouse-tracking TUI. Without dispatching the user's
      // chosen action here, right-click paste silently stops working in
      // opencode, tmux with `mouse on`, vim with `set mouse=a`, etc. (#941).
      // Middle-click still works because its auxclick listener lives in
      // createXTermRuntime and isn't gated by mouseTracking.
      const behavior = terminalSettingsRef.current?.rightClickBehavior;
      if (behavior === 'paste') {
        void terminalContextActionsRef.current?.onPaste?.();
      } else if (behavior === 'select-word') {
        terminalContextActionsRef.current?.onSelectWord?.();
      }
      // 'context-menu' is intentionally not handled — Radix opens the
      // menu via its own pointerdown listener, which our capture handler
      // does not intercept.
    };

    const handleMouseUpCapture = (e: MouseEvent) => {
      if (e.button === 2 && mouseTrackingRef.current && statusRef.current === 'connected') {
        e.stopImmediatePropagation();
      }
    };

    el.addEventListener('contextmenu', handleContextMenuCapture, true);
    el.addEventListener('mouseup', handleMouseUpCapture, true);
    return () => {
      el.removeEventListener('contextmenu', handleContextMenuCapture, true);
      el.removeEventListener('mouseup', handleMouseUpCapture, true);
    };
  }, [sessionId]);


  useEffect(() => {
    if (!isVisible) return;

    let resizeTimeout: ReturnType<typeof setTimeout> | null = null;

    const handler = () => {
      if (!isVisibleRef.current) return;
      if (resizeTimeout) {
        clearTimeout(resizeTimeout);
      }
      resizeTimeout = setTimeout(() => {
        safeFit({ requireVisible: true });
      }, 250);
    };

    window.addEventListener("resize", handler);
    return () => {
      if (resizeTimeout) clearTimeout(resizeTimeout);
      window.removeEventListener("resize", handler);
    };
  }, [isVisible]);


  // Only register the snippet executor once the terminal session is ready.
  // Before that, TerminalLayer falls back to raw writeToSession which is the
  // correct path for sessions that are still connecting.
  useEffect(() => {
    if (status !== "connected") {
      onSnippetExecutorChange?.(sessionId, null);
      return;
    }
    onSnippetExecutorChange?.(sessionId, executeSnippetCommand);
    return () => onSnippetExecutorChange?.(sessionId, null);
  }, [executeSnippetCommand, onSnippetExecutorChange, sessionId, status]);
}

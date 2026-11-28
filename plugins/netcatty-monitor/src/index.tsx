import React from 'react';
import { definePlugin } from '@netcatty/plugin-sdk';
import { registerHostReactView } from '@netcatty/plugin-sdk/host-react';
import css from './style.css';
import { MONITOR_WORKBENCH_VIEW_ID } from './services/hostBridge';
import { MonitorWorkbench } from './ui/MonitorWorkbench';

export default definePlugin({
  activate(context) {
    context.subscriptions.add(
      registerHostReactView(
        context.views,
        MONITOR_WORKBENCH_VIEW_ID,
        () => <MonitorWorkbench context={context} />,
        css,
      ),
    );
    context.subscriptions.add({
      dispose() {
        if (typeof context.views.setBadge === 'function') {
          void context.views.setBadge(MONITOR_WORKBENCH_VIEW_ID, null).catch(() => {});
        }
      },
    });
  },
});

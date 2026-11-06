import { registerHostDomView } from '@netcatty/plugin-sdk/host-dom';
import plugin from './src/index.js';
import { mount } from './panel.js';
import html from './view.html';
import css from './view.css';
import manifest from './netcatty.plugin.json';
export default {
  async activate(context) {
    await plugin.activate(context);
    for (const view of manifest.contributes.views) context.subscriptions.add(registerHostDomView(context.views, view.id, (root, stateScope) => {
      root.innerHTML = html;
      return mount(root, context, view.id, stateScope);
    }, css));
  },
  deactivate: plugin.deactivate,
};

import CDP from 'chrome-remote-interface';

import JavaScriptPlugin from './plugins/JavaScriptPlugin';
import { getVisualSelection, debounce } from './utils';
import { echomsg, echoerr } from './echo';

import { tmpdir } from 'os';
import { appendFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';

export default class ChromeDevToolsPlugin {
  constructor(plugin) {
    this._plugin = plugin;
    this._nvim = plugin.nvim;
    this.networkFile = '';
    // This compiled file is in lib, and we need to get to vim-chrome-devtools:
    this.pluginDir = dirname(dirname(dirname(dirname(__dirname))));

    process.on('uncaughtException', err => {
      console.error(err);
    });

    this._js = new JavaScriptPlugin(plugin);

    plugin.registerFunction('ChromeDevTools_Page_reload', this.pageReload, {
      sync: false,
    });

    plugin.registerFunction(
      'ChromeDevTools_CSS_createStyleSheet',
      this.cssCreateStyleSheet,
      { sync: false },
    );

    plugin.registerFunction(
      'ChromeDevTools_Network_openLog',
      this.openNetworkLog,
      { sync: false },
    );

    plugin.registerCommand('ChromeDevToolsConnect', this.listOrConnect, {
      nargs: '*',
    });

    plugin.registerAutocmd('TextChanged', this.cssSetStyleSheetText, {
      pattern: '*.css',
    });
    plugin.registerAutocmd(
      'TextChangedI',
      debounce(this.cssSetStyleSheetText, 200),
      { pattern: '*.css' },
    );
  }

  async _getDefaultOptions() {
    const port = await this._nvim.getVar('ChromeDevTools_port');
    const host = await this._nvim.getVar('ChromeDevTools_host');

    return {
      host: host && typeof host == 'string' ? host : 'localhost',
      port: port && typeof port == 'string' ? port : '9222',
    };
  }

  async _setupNetwork(chrome) {
    const networkDir = tmpdir();
    this.networkRequestFile = networkDir + '/requests.ndjson';
    this.networkResponseFile = networkDir + '/responses.ndjson';
    writeFileSync(this.networkRequestFile, '');
    writeFileSync(this.networkResponseFile, '');

    chrome.Network.requestWillBeSent(request => {
      appendFileSync(this.networkRequestFile, JSON.stringify(request) + '\n');
    });

    chrome.Network.responseReceived(response => {
      appendFileSync(this.networkResponseFile, JSON.stringify(response) + '\n');
    });
    await chrome.Network.enable();
  }

  listOrConnect = (args) => {
    if (args.length == 0) {
      this.list();
    } else {
      const [target] = args[0].split(':');
      this.connect(target);
    }
  };

  list = async () => {
    let targets;
    try {
      targets = await CDP.List(await this._getDefaultOptions());
    } catch (e) {
      echoerr(this._nvim, e.message);
    }

    if (!targets) {
      return;
    }

    const labels = targets.map(
      ({ id, title, url }) => `${id}: ${title} - ${url}`,
    );

    if (labels.length == 0) {
      echomsg(this._nvim, 'No targets available.');
    } else if (labels.length == 1) {
      this.connect(targets[0].id);
    } else {
      await this._nvim.call('fzf#run', {
        down: '40%',
        sink: 'ChromeDevToolsConnect',
        source: labels,
      });
    }
  };

  openNetworkLog = async () => {
    const previewCommand = [
      `'${this.pluginDir}/preview-network.sh'`,
      this.networkResponseFile,
      '{}',
    ];

    const options = await this._nvim.call('fzf#wrap', {
      sink: 'echomsg',
      source: `'${this.pluginDir}/source-network.sh' '${this.networkRequestFile}'`,
      options: [
        '--preview', previewCommand.join(' '),
      ]
    });

    echomsg(this._nvim, this.networkResponseFile);
    echomsg(this._nvim, this.networkRequestFile);

    await this._nvim.call('fzf#run', options);
  };

  connect = async (target) => {
    const defaultOptions = await this._getDefaultOptions();
    const chrome = await CDP({ ...defaultOptions, target });
    this._chrome = chrome;

    this._js._chrome = chrome;
    this._scripts = [];
    chrome.Debugger.scriptParsed(script => {
      this._scripts.push(script);
    });

    await chrome.Page.enable();
    await chrome.DOM.enable();
    await chrome.CSS.enable();
    await chrome.Runtime.enable();
    await chrome.Debugger.enable();

    await this._setupNetwork(chrome);

    chrome.once('disconnect', () => {
      echomsg(this._nvim, 'Disconnected from target.');
    });

    echomsg(this._nvim, 'Connected to target: ' + target);
  };

  pageReload = () => {
    this._chrome.Page.reload();
  };

  cssCreateStyleSheet = async () => {
    const { _chrome: chrome, _nvim: nvim } = this;

    // Get the top level frame id.
    const { frameTree } = await chrome.Page.getResourceTree();
    const frameId = frameTree.frame.id;

    const { styleSheetId } = await chrome.CSS.createStyleSheet({ frameId });
    await nvim.command(`exec "edit " . system('mktemp --suffix .css')`);
    const buffer = await nvim.buffer;
    await buffer.setVar('ChromeDevTools_styleSheetId', styleSheetId);
  };

  cssSetStyleSheetText = async () => {
    const buffer = await this._nvim.buffer;
    const styleSheetId = await buffer.getVar('ChromeDevTools_styleSheetId');

    if (!styleSheetId || typeof styleSheetId != 'string') {
      return;
    }

    const lines = await buffer.lines;
    const text = lines.join('\n');
    await this._chrome.CSS.setStyleSheetText({ styleSheetId, text });
  };
}

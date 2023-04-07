import CDP from 'chrome-remote-interface';

import JavaScriptPlugin from './plugins/JavaScriptPlugin';
import { getVisualSelection, debounce } from './utils';
import { echomsg, echoerr } from './echo';

import { tmpdir } from 'os';
import { watch, readFileSync, appendFileSync, writeFileSync } from 'fs';
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

    plugin.registerFunction('ChromeDevTools_navigate', this.navigate, {
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

    plugin.registerCommand('FzfEditSink', this.editIgnoringExtraArgs, {
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

  _decodeBody(result) {
    if (result.base64Encoded) {
      return Buffer.from(result.body, "base64").toString("utf-8");
    }
    return result.body;
  }

  async _getAndWriteBody(requestId) {
    this._chrome.Network.getResponseBody({requestId}).then(result => {
      appendFileSync(this.networkPreviewFile, this._decodeBody(result));
      appendFileSync(this.networkPreviewFile, '\n');
    }, error => {
      echoerr(this._nvim, error);
    });
  }

  async _setupNetwork(chrome) {
    const networkDir = tmpdir();
    this.networkRequestFile = networkDir + '/requests.ndjson';
    this.networkResponseFile = networkDir + '/responses.ndjson';
    this.networkPreviewRequestedFile = networkDir + '/requested-preview.txt';
    this.networkPreviewFile = networkDir + '/response-body.txt';
    writeFileSync(this.networkPreviewFile, '');
    writeFileSync(this.networkPreviewRequestedFile, '');
    writeFileSync(this.networkRequestFile, '');
    writeFileSync(this.networkResponseFile, '');

    watch(this.networkPreviewRequestedFile, (eventType, filename) => {
      const requestId = readFileSync(this.networkPreviewRequestedFile, 'utf-8');
      try {
        this._getAndWriteBody(requestId.trim());
      } catch (e) {
        echoerr(this._nvim, String(e));
      }
    });

    chrome.Network.requestWillBeSent(request => {
      appendFileSync(this.networkRequestFile, JSON.stringify(request) + '\n');
    });

    chrome.Network.responseReceived(response => {
      appendFileSync(this.networkResponseFile, JSON.stringify(response) + '\n');
    });
    await chrome.Network.enable();
  }

  editIgnoringExtraArgs = (args) => {
    const filename = args.join(' ').split('****')[0].trim();
    this._nvim.command(`edit ${filename}`);
  };

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
      echomsg(this._nvim, `Only one target - connecting to ${labels[1]}`);
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
      this.networkPreviewRequestedFile,
      this.networkPreviewFile,
      '{}',
    ];

    const options = await this._nvim.call('fzf#wrap', {
      sink: `FzfEditSink ${this.networkPreviewFile} ****`,
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
    this._chrome.Page.reload({ignoreCache: true});
  };

  navigate = (args) => {
    let typedUrl = args[0];
    this._chrome.Page.getNavigationHistory().then(history => {
      const base = history.entries[history.currentIndex].url;
      // Do our best to guess at what the user wants:
      if (
        (typedUrl.includes('.') || typedUrl.includes(':')) &&
        !typedUrl.includes('://')
      ) {
        typedUrl = 'http://' + typedUrl;
      }
      let url;
      try {
        url = new URL(typedUrl, base);
      } catch (e) {
        echoerr(this._nvim, e);
        return;
      }
      this._chrome.Page.navigate({url}).then(() => {}, e => {
        echoerr(this._nvim, e);
      });
    });
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

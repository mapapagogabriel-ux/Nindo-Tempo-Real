// ======================== PROCESSO PRINCIPAL DO ELECTRON ========================
// Launcher Nindo Kyojin — Minecraft 1.12.2 com Forge
// Usa minecraft-launcher-core (MCLC) para baixar e iniciar o jogo

const { app, BrowserWindow, Menu, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const AdmZip = require('adm-zip');
const { Client, Authenticator } = require('minecraft-launcher-core');
const { execSync } = require('child_process');

// ---- Desabilitar aceleração por hardware (evita janela invisível) ----
app.disableHardwareAcceleration();

// ---- Desabilitar o menu padrão do Electron ----
Menu.setApplicationMenu(null);

// ---- Referência da janela principal ----
let mainWindow = null;

// ---- Pasta raiz do Minecraft (.nindo-kyojin) ----
const gameDir = path.join(app.getPath('appData'), '.nindo-kyojin');

// ---- Pasta do Java portátil ----
const javaDir = path.join(__dirname, 'java');

// ---- Log em arquivo para diagnóstico ----
const logFile = path.join(__dirname, 'electron_log.txt');
fs.writeFileSync(logFile, ''); // Limpar log a cada inicialização

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  fs.appendFileSync(logFile, line);
  console.log(msg);
}

// ---- Enviar mensagem para o renderer de forma segura ----
function sendToRenderer(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

// ============================================================
// DOWNLOAD DE ARQUIVOS COM SUPORTE A REDIRECT
// ============================================================
function downloadFile(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    const protocol = url.startsWith('https') ? https : http;

    function doRequest(requestUrl) {
      protocol.get(requestUrl, { headers: { 'User-Agent': 'NindoCraft-Launcher' } }, (response) => {
        // Seguir redirects (301, 302, 307, 308)
        if ([301, 302, 307, 308].includes(response.statusCode) && response.headers.location) {
          log('Redirect para: ' + response.headers.location);
          // Usar o módulo correto baseado no protocolo do redirect
          const redirectUrl = response.headers.location;
          const redirectProtocol = redirectUrl.startsWith('https') ? https : http;
          redirectProtocol.get(redirectUrl, { headers: { 'User-Agent': 'NindoCraft-Launcher' } }, (redirectResponse) => {
            if (redirectResponse.statusCode >= 300 && redirectResponse.statusCode < 400 && redirectResponse.headers.location) {
              // Segundo redirect
              const finalUrl = redirectResponse.headers.location;
              const finalProtocol = finalUrl.startsWith('https') ? https : http;
              finalProtocol.get(finalUrl, { headers: { 'User-Agent': 'NindoCraft-Launcher' } }, (finalResponse) => {
                handleDownload(finalResponse, file, onProgress, resolve, reject);
              }).on('error', reject);
            } else {
              handleDownload(redirectResponse, file, onProgress, resolve, reject);
            }
          }).on('error', reject);
          return;
        }

        handleDownload(response, file, onProgress, resolve, reject);
      }).on('error', (err) => {
        fs.unlink(destPath, () => {});
        reject(err);
      });
    }

    doRequest(url);
  });
}

function handleDownload(response, file, onProgress, resolve, reject) {
  if (response.statusCode !== 200) {
    file.close();
    reject(new Error(`HTTP ${response.statusCode}`));
    return;
  }

  const totalBytes = parseInt(response.headers['content-length'], 10) || 0;
  let downloadedBytes = 0;

  response.on('data', (chunk) => {
    downloadedBytes += chunk.length;
    if (totalBytes > 0 && onProgress) {
      const percent = Math.round((downloadedBytes / totalBytes) * 100);
      onProgress(percent, downloadedBytes, totalBytes);
    }
  });

  response.pipe(file);

  file.on('finish', () => {
    file.close();
    resolve(file.path);
  });

  file.on('error', (err) => {
    fs.unlink(file.path, () => {});
    reject(err);
  });
}

// ============================================================
// DETECTAR JAVA INSTALADO
// ============================================================
function findJava() {
  // 1. Priorizar o Java embutido na pasta java/ do projeto
  if (fs.existsSync(javaDir)) {
    try {
      const entries = fs.readdirSync(javaDir);
      for (const entry of entries) {
        const javaExe = path.join(javaDir, entry, 'bin', 'java.exe');
        if (fs.existsSync(javaExe)) {
          log('Java embutido encontrado: ' + javaExe);
          return javaExe;
        }
        // Checar subpastas (ex: jdk-21.0.x+y/bin/java.exe ou jdk-21.0.x+y-jre/bin/java.exe)
        const subPath = path.join(javaDir, entry);
        if (fs.statSync(subPath).isDirectory()) {
          const subEntries = fs.readdirSync(subPath);
          for (const sub of subEntries) {
            const deepJava = path.join(subPath, sub, 'bin', 'java.exe');
            if (fs.existsSync(deepJava)) {
              log('Java embutido encontrado (sub): ' + deepJava);
              return deepJava;
            }
          }
        }
      }
      // Checar direto na raiz java/bin/java.exe
      const directJava = path.join(javaDir, 'bin', 'java.exe');
      if (fs.existsSync(directJava)) {
        log('Java embutido encontrado (direto): ' + directJava);
        return directJava;
      }
    } catch(e) {
      log('Erro ao buscar java embutido: ' + e.message);
    }
  }

  // 2. Tentar JAVA_HOME
  if (process.env.JAVA_HOME) {
    const javaPath = path.join(process.env.JAVA_HOME, 'bin', 'java.exe');
    if (fs.existsSync(javaPath)) {
      log('Java encontrado via JAVA_HOME: ' + javaPath);
      return javaPath;
    }
  }

  // 3. Tentar java no PATH
  try {
    const result = execSync('where java', { encoding: 'utf8', timeout: 5000 });
    const javaPath = result.trim().split('\n')[0].trim();
    if (javaPath && fs.existsSync(javaPath)) {
      log('Java encontrado no PATH: ' + javaPath);
      return javaPath;
    }
  } catch (e) { /* não encontrado */ }

  // 4. Procurar em locais comuns do Windows
  const commonPaths = [
    'C:\\Program Files\\Java',
    'C:\\Program Files (x86)\\Java',
    'C:\\Program Files\\Eclipse Adoptium',
  ];
  for (const basePath of commonPaths) {
    if (fs.existsSync(basePath)) {
      try {
        const dirs = fs.readdirSync(basePath).sort().reverse();
        for (const dir of dirs) {
          const javaExe = path.join(basePath, dir, 'bin', 'java.exe');
          if (fs.existsSync(javaExe)) {
            log('Java encontrado em: ' + javaExe);
            return javaExe;
          }
        }
      } catch (e) { /* ignorar */ }
    }
  }

  log('Java NÃO encontrado em nenhum lugar!');
  return null;
}

// ============================================================
// DOWNLOAD AUTOMÁTICO DO JAVA 8 (Adoptium — compatível com MC 1.12.2)
// ============================================================
async function downloadJava() {
  // URL direta do Adoptium — Java 8 JRE para Windows x64 (necessário para MC 1.12.2)
  const javaUrl = 'https://api.adoptium.net/v3/binary/latest/8/ga/windows/x64/jre/hotspot/normal/eclipse?project=jdk';
  const zipPath = path.join(__dirname, 'java-download.zip');

  log('=== BAIXANDO JAVA 8 (Adoptium — para MC 1.12.2) ===');
  log('URL: ' + javaUrl);
  log('Destino ZIP: ' + zipPath);

  sendToRenderer('launch-status', 'downloading-java');
  sendToRenderer('launch-progress', { type: 'java', task: 0, total: 100, percent: 0 });

  try {
    await downloadFile(javaUrl, zipPath, (percent, downloaded, total) => {
      const mb = (downloaded / 1024 / 1024).toFixed(1);
      const totalMb = (total / 1024 / 1024).toFixed(1);
      log(`[JAVA] Baixando... ${percent}% (${mb}MB / ${totalMb}MB)`);
      sendToRenderer('launch-progress', {
        type: 'java',
        task: percent,
        total: 100,
        percent: percent
      });
    });

    log('Download do Java concluído! Extraindo...');
    sendToRenderer('launch-status', 'extracting-java');

    // Criar pasta java/ se não existir
    if (!fs.existsSync(javaDir)) {
      fs.mkdirSync(javaDir, { recursive: true });
    }

    // Extrair ZIP
    log('Extraindo ZIP para: ' + javaDir);
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(javaDir, true);
    log('Extração concluída!');

    // Apagar o ZIP
    fs.unlinkSync(zipPath);
    log('ZIP removido.');

    // Procurar java.exe na pasta extraída
    const javaExe = findJava();
    if (javaExe) {
      log('Java instalado com sucesso: ' + javaExe);
      return javaExe;
    } else {
      throw new Error('Java foi baixado e extraído, mas java.exe não foi encontrado na pasta.');
    }

  } catch (err) {
    log('ERRO ao baixar Java: ' + err.message);
    // Limpar ZIP se ficou pra trás
    if (fs.existsSync(zipPath)) {
      try { fs.unlinkSync(zipPath); } catch(e) {}
    }
    throw err;
  }
}

// ============================================================
// CRIAÇÃO DA JANELA PRINCIPAL
// ============================================================
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 700,
    minWidth: 900,
    minHeight: 600,
    title: 'Nindo Craft',
    icon: path.join(__dirname, 'icon.png'),
    backgroundColor: '#0a0a0c',
    frame: false,
    resizable: true,
    center: true,
    show: true,
    skipTaskbar: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    }
  });

  mainWindow.loadFile('index.html');

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ============================================================
// IPC: ABRIR URL EXTERNA NO NAVEGADOR
// ============================================================
ipcMain.on('open-external', (event, url) => {
  shell.openExternal(url);
});

// ============================================================
// IPC: LANÇAR O MINECRAFT
// ============================================================
let isLaunching = false;

ipcMain.on('launch-game', async (event, data) => {
  // Evitar lançamento duplo
  if (isLaunching) {
    log('Já está lançando, ignorando...');
    return;
  }
  isLaunching = true;

  const { nick, ram } = data;
  log(`=== INICIANDO MINECRAFT ===`);
  log(`Nick: ${nick} | RAM: ${ram}GB`);
  log(`Diretório: ${gameDir}`);

  // Criar pasta do jogo se não existir
  if (!fs.existsSync(gameDir)) {
    fs.mkdirSync(gameDir, { recursive: true });
  }

  // Verificar Java — se não encontrou, BAIXAR AUTOMATICAMENTE
  let javaPath = findJava();
  
  if (!javaPath) {
    log('Java não encontrado. Iniciando download automático...');
    try {
      javaPath = await downloadJava();
    } catch (err) {
      sendToRenderer('launch-error', 
        'Não foi possível baixar o Java automaticamente.\n\n' +
        'Erro: ' + err.message + '\n\n' +
        'Tente baixar manualmente em: https://adoptium.net/temurin/releases/'
      );
      isLaunching = false;
      return;
    }
  }

  if (!javaPath) {
    sendToRenderer('launch-error', 'Java não encontrado mesmo após tentativa de download.');
    isLaunching = false;
    return;
  }

  try {
    // ---- LER CONFIGURAÇÕES ----
    const configPath = path.join(__dirname, 'config.json');
    if (fs.existsSync(configPath)) {
      const configData = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (configData.update_url) {
        log('Verificando atualizações no site: ' + configData.update_url);
        sendToRenderer('launch-status', 'updating-mods');

        const updateJsonPath = path.join(gameDir, 'update.json');
        
        try {
          await downloadFile(configData.update_url, updateJsonPath);
          const updateData = JSON.parse(fs.readFileSync(updateJsonPath, 'utf8'));
          
          if (updateData.mods && updateData.base_url_mods) {
            const modsDir = path.join(gameDir, 'mods');
            if (!fs.existsSync(modsDir)) {
              fs.mkdirSync(modsDir, { recursive: true });
            }

            const activeMods = updateData.mods;
            const baseUrl = updateData.base_url_mods.endsWith('/') ? updateData.base_url_mods : updateData.base_url_mods + '/';
            
            // 1. Remover mods antigos que não estão na lista
            const currentMods = fs.readdirSync(modsDir).filter(f => f.endsWith('.jar') || f.endsWith('.zip'));
            for (const file of currentMods) {
              if (!activeMods.includes(file)) {
                log('Removendo mod descontinuado: ' + file);
                fs.unlinkSync(path.join(modsDir, file));
              }
            }

            // 2. Baixar mods novos que não estão na pasta
            for (let i = 0; i < activeMods.length; i++) {
              const modName = activeMods[i];
              const modPath = path.join(modsDir, modName);
              
              if (!fs.existsSync(modPath)) {
                const modUrl = baseUrl + modName;
                log(`Baixando mod: ${modName} de ${modUrl}`);
                sendToRenderer('launch-progress', { type: 'mod', task: i + 1, total: activeMods.length, percent: Math.round(((i) / activeMods.length) * 100) });
                
                try {
                  await downloadFile(modUrl, modPath);
                } catch (e) {
                  log(`Falha ao baixar mod ${modName}: ${e.message}`);
                }
              }
            }
          }
        } catch (e) {
          log('Erro ao ler update.json remoto: ' + e.message);
        }
      }
    }

    // ---- Autenticação offline ----
    const authResult = Authenticator.getAuth(nick);
    log('Autenticação offline criada para: ' + nick);

    // ---- Baixar Forge se necessário ----
    const forgeVersion = '14.23.5.2860';
    const forgeFileName = `forge-1.12.2-${forgeVersion}-installer.jar`;
    const forgePath = path.join(gameDir, forgeFileName);

    if (!fs.existsSync(forgePath)) {
      log('Forge não encontrado. Baixando Forge ' + forgeVersion + '...');
      sendToRenderer('launch-status', 'downloading-forge');

      const forgeUrl = `https://maven.minecraftforge.net/net/minecraftforge/forge/1.12.2-${forgeVersion}/forge-1.12.2-${forgeVersion}-installer.jar`;
      log('URL do Forge: ' + forgeUrl);

      try {
        await downloadFile(forgeUrl, forgePath, (percent, downloaded, total) => {
          const mb = (downloaded / 1024 / 1024).toFixed(1);
          const totalMb = (total / 1024 / 1024).toFixed(1);
          log(`[FORGE] Baixando... ${percent}% (${mb}MB / ${totalMb}MB)`);
          sendToRenderer('launch-progress', {
            type: 'forge',
            task: percent,
            total: 100,
            percent: percent
          });
        });
        log('Forge baixado com sucesso!');
      } catch (err) {
        log('ERRO ao baixar Forge: ' + err.message);
        sendToRenderer('launch-error', 'Não foi possível baixar o Forge.\n\nErro: ' + err.message);
        isLaunching = false;
        return;
      }
    } else {
      log('Forge já existe: ' + forgePath);
    }

    // ---- Configuração do MCLC com Forge ----
    const opts = {
      authorization: authResult,
      root: gameDir,
      javaPath: javaPath,
      forge: forgePath,
      version: {
        number: '1.12.2',
        type: 'release'
      },
      memory: {
        max: `${ram}G`,
        min: '1G'
      },
      window: {
        width: 1280,
        height: 720
      }
    };

    log('Configuração MCLC com Forge pronta. Iniciando...');
    sendToRenderer('launch-status', 'downloading');

    // ---- Criar nova instância do launcher para cada lançamento ----
    const mcLauncher = new Client();

    // ---- Eventos de progresso ----
    mcLauncher.on('debug', (e) => {
      log('[DEBUG] ' + e);
    });

    mcLauncher.on('data', (e) => {
      log('[GAME] ' + e);
    });

    mcLauncher.on('progress', (e) => {
      const percent = Math.round((e.task / e.total) * 100);
      log(`[PROGRESSO] ${e.type}: ${e.task}/${e.total} (${percent}%)`);
      sendToRenderer('launch-progress', {
        type: e.type,
        task: e.task,
        total: e.total,
        percent: percent
      });
    });

    mcLauncher.on('download-status', (e) => {
      log(`[DOWNLOAD] ${e.type}: ${e.current}/${e.total}`);
      sendToRenderer('launch-progress', {
        type: e.type,
        task: e.current,
        total: e.total,
        percent: Math.round((e.current / e.total) * 100)
      });
    });

    mcLauncher.on('arguments', (args) => {
      log('Argumentos JVM prontos. Minecraft iniciando!');
      sendToRenderer('launch-status', 'launching');
    });

    mcLauncher.on('close', (code) => {
      log(`Minecraft fechado com código: ${code}`);
      sendToRenderer('launch-status', 'closed');
      isLaunching = false;
    });

    mcLauncher.on('error', (err) => {
      log(`ERRO MCLC: ${err}`);
      sendToRenderer('launch-error', err.toString());
      isLaunching = false;
    });

    // ---- Lançar o Minecraft ----
    mcLauncher.launch(opts);

  } catch (err) {
    log(`ERRO FATAL: ${err.message}`);
    sendToRenderer('launch-error', err.message);
    isLaunching = false;
  }
});

// ============================================================
// IPC: CONTROLES DA JANELA (titlebar customizada)
// ============================================================
ipcMain.on('window-minimize', () => {
  if (mainWindow) mainWindow.minimize();
});

ipcMain.on('window-maximize', () => {
  if (mainWindow) {
    mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
  }
});

ipcMain.on('window-close', () => {
  if (mainWindow) mainWindow.close();
});

// ============================================================
// INICIALIZAÇÃO DO APP
// ============================================================
app.whenReady().then(() => {
  log('App ready! Criando janela...');
  createWindow();
  log('Janela criada com sucesso.');
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

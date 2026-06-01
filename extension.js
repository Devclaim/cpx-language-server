"use strict";

const path = require("path");
const vscode = require("vscode");
const { LanguageClient, TransportKind } = require("vscode-languageclient/node");

let client;

function activate(context) {
    const serverModule = context.asAbsolutePath(path.join("server.js"));
    const serverOptions = {
        run: {
            module: serverModule,
            transport: TransportKind.ipc
        },
        debug: {
            module: serverModule,
            transport: TransportKind.ipc,
            options: {
                execArgv: ["--nolazy", "--inspect=6009"]
            }
        }
    };

    const clientOptions = {
        documentSelector: [{ scheme: "file", language: "cpx" }],
        synchronize: {
            fileEvents: vscode.workspace.createFileSystemWatcher("**/*.cpx")
        }
    };

    client = new LanguageClient(
        "cpxLanguageServer",
        "CPX Language Server",
        serverOptions,
        clientOptions
    );

    context.subscriptions.push(client.start());
}

function deactivate() {
    if (!client) {
        return undefined;
    }

    return client.stop();
}

module.exports = {
    activate,
    deactivate
};

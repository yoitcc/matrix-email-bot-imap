import { MatrixBot } from "./MatrixBot";
import { DataStore, IDbAttachment, IDbMessage } from "./DataStore";
import config from "./config";
import * as mailin from "mailin";
import { getRoomConfigsForTarget } from "./configUtils";
import * as replyParser from "node-email-reply-parser";
import { MessageType } from "./MessageType";

import SimpleImapAsync = require("simple-node-imap-async");

interface IEmailTarget {
    address: string;
    name: string;
    source: "to" | "cc" | "bcc";
}

export class EmailProcessor {
    public constructor(private bot: MatrixBot, private db: DataStore) {
        if (config.mail.enabled) {
            mailin.start({
                port: config.mail.port,
                disableWebhook: true,
            });

            mailin.on('message', (connection, data, content) => {
                this.processMessage(data).then();
            });
        }
        if (config.imap.enabled) {
            const simpleImapAsync = new SimpleImapAsync({
                username: config.imap.username, // Will be deprecated on May 30, 2022
                password: config.imap.password, // Will be deprecated on May 30, 2022
                host: config.imap.host,
                port: config.imap.port, // imap port
                tls: true,
                connTimeout: 10000, // Default by node-imap
                authTimeout: 5000, // Default by node-imap,
                debug: console.log, // Or your custom function with only one incoming argument. Default: null
                tlsOptions: { rejectUnauthorized: false },
                mailbox: "INBOX", // mailbox to monitor
                searchFilter: ["UNSEEN", "FLAGGED"], // the search filter being used after an IDLE notification has been retrieved
                markSeen: false, // all fetched email willbe marked as seen and not fetched next time
                fetchUnreadOnStart: true, // use it only if you want to get all unread email on lib start. Default is `false`,
                mailParserOptions: {streamAttachments: true}, // options to be passed to mailParser lib.
                attachments: true, // download attachments as they are encountered to the project directory
            });
            simpleImapAsync.start(); // start listening

            simpleImapAsync.on("server:connected", () => {
                LogService.info("EmailProcessor", "imapConnected"));
            });

            simpleImapAsync.on("server:disconnected", () => {
                LogService.info("EmailProcessor", "imapDisonnected"));
            });

            simpleImapAsync.on("error", err => {
                LogService.info("EmailProcessor", "imapErrored"));
            });

            simpleImapAsync.on("message", message => {
                LogService.info("EmailProcessor", "imapMessageFollows:"));
                LogService.info("EmailProcessor", message));
                this.processIMAPMessage(message).then();
            });
        }

    public async processMessage(message: any) {
        if (await this.db.doesMessageExist(message.messageId)) {
            return;
        }

        const targets: IEmailTarget[] = [];

        for (const email of (message.to || [])) targets.push({address: email.address, name: email.name, source: 'to'});
        for (const email of (message.cc || [])) targets.push({address: email.address, name: email.name, source: 'cc'});
        for (const email of (message.bcc || [])) targets.push({address: email.address, name: email.name, source: 'bcc'});

        const primaryFrom = message.from[0];

        const rooms: string[] = [];
        for (const target of targets) {
            if (!target.address) continue;

            const roomConfigs = getRoomConfigsForTarget(target.address, target.source);
            if (!roomConfigs) continue;

            for (const roomConfig of roomConfigs) {
                if (rooms.includes(roomConfig.roomId)) {
                    continue;
                }

                if (roomConfig.antispam) {
                    if (roomConfig.antispam.maxScore > 0 && roomConfig.antispam.maxScore <= message.spamScore) {
                        continue;
                    }

                    if (roomConfig.antispam.blockFailedDkim && message.dkim !== "pass") {
                        continue;
                    }

                    if (roomConfig.antispam.blockFailedSpf && message.spf !== "pass") {
                        continue;
                    }
                }

                let allowed = true;
                if (!roomConfig.allowFromAnyone) {
                    for (const fromAddress of message.from) {
                        if (!fromAddress.address) continue;

                        if (!roomConfig.allowedSenders.includes(fromAddress.address.toLowerCase())) {
                            allowed = false;
                            break;
                        }
                    }
                }

                for (const fromAddress of message.from) {
                    if (!fromAddress.address) continue;

                    if (roomConfig.blockedSenders.includes(fromAddress.address.toLowerCase())) {
                        allowed = false;
                        break;
                    }
                }

                if (!allowed) continue;

                const attachments: IDbAttachment[] = [];
                if (message.attachments) {
                    const allowedTypes = (roomConfig.attachments.allowedTypes || []);
                    const blockedTypes = (roomConfig.attachments.blockedTypes || []);
                    for (const attachment of message.attachments) {
                        if (!roomConfig.attachments.allowAllTypes && !allowedTypes.includes(attachment.contentType)) {
                            continue;
                        }

                        if (blockedTypes.includes(attachment.contentType)) {
                            continue;
                        }

                        attachments.push({
                            name: attachment.generatedFileName,
                            content: attachment.content,
                            post: roomConfig.attachments.post,
                            type: attachment.contentType,
                        });
                    }
                }

                rooms.push(roomConfig.roomId);

                const contentTypeHeader = (message.headers['content-type'] || "text/plain").toLowerCase();
                const isHtml = contentTypeHeader.indexOf('text/plain') !== 0;
                const htmlBody = message.html;
                const textBody = message.text;
                const fullTextBody = message.text;

                let textSegments = [textBody];

                if (roomConfig.postReplies) {
                    textSegments = replyParser(textBody).getFragments().map(f => f.getContent());
                } else {
                    textSegments = [replyParser(textBody, true)];
                }

                textSegments = textSegments.filter(s => s.trim().length > 0);

                const dbMessages: IDbMessage[] = [];
                for (const segment of textSegments) {
                    dbMessages.push({
                        email_id: message.messageId,
                        from_name: primaryFrom.name || "",
                        from_email: primaryFrom.address,
                        to_name: target.name || "",
                        to_email: target.address,
                        subject: message.subject,
                        text_body: segment,
                        html_body: htmlBody,
                        full_text_body: fullTextBody,
                        is_html: isHtml,
                        target_room: roomConfig.roomId,
                    });
                }

                let msgType = MessageType.Primary;

                for (const message of dbMessages) {
                    let msg = message;
                    if (!roomConfig.skipDatabase) {
                        const messageId = await this.db.writeMessage(message);
                        await this.db.writeAttachments(attachments, messageId);
                        msg = await this.db.getMessage(messageId);
                    }

                    await this.bot.sendMessage(msg, roomConfig.roomId, msgType);
                    msgType = MessageType.Fragment;
                }
                for (const attachment of attachments) {
                    if (!attachment.post) continue;
                    await this.bot.sendAttachment(attachment, roomConfig.roomId);
                }
            }
        }
    }
}

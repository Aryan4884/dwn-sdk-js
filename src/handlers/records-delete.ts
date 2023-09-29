import type { EventLog } from '../types/event-log.js';
import type { GenericMessageReply } from '../core/message-reply.js';
import type { MethodHandler } from '../types/method-handler.js';
import type { DataStore, DidResolver, MessageStore } from '../index.js';
import type { RecordsDeleteMessage, RecordsWriteMessage } from '../types/records-types.js';

import { authenticate } from '../core/auth.js';
import { messageReplyFromError } from '../core/message-reply.js';
import { RecordsDelete } from '../interfaces/records-delete.js';
import { RecordsWrite } from '../interfaces/records-write.js';
import { removeUndefinedProperties } from '../utils/object.js';
import { StorageController } from '../store/storage-controller.js';
import { DwnInterfaceName, DwnMethodName, Message } from '../core/message.js';

export class RecordsDeleteHandler implements MethodHandler {

  constructor(private didResolver: DidResolver, private messageStore: MessageStore, private dataStore: DataStore, private eventLog: EventLog) { }

  public async handle({
    tenant,
    message
  }: { tenant: string, message: RecordsDeleteMessage}): Promise<GenericMessageReply> {

    let recordsDelete: RecordsDelete;
    try {
      recordsDelete = await RecordsDelete.parse(message);
    } catch (e) {
      return messageReplyFromError(e, 400);
    }

    // authentication & authorization
    try {
      await authenticate(message.authorization, this.didResolver);
      await recordsDelete.authorize(tenant);
    } catch (e) {
      return messageReplyFromError(e, 401);
    }

    // get existing records matching the `recordId`
    const query = {
      interface : DwnInterfaceName.Records,
      recordId  : message.descriptor.recordId
    };
    const { messages: existingMessages } = await this.messageStore.query(tenant, [ query ]);

    // find which message is the newest, and if the incoming message is the newest
    const newestExistingMessage = await Message.getNewestMessage(existingMessages);
    let incomingMessageIsNewest = false;
    let newestMessage;
    // if incoming message is newest
    if (newestExistingMessage === undefined || await Message.isNewer(message, newestExistingMessage)) {
      incomingMessageIsNewest = true;
      newestMessage = message;
    } else { // existing message is the same age or newer than the incoming message
      newestMessage = newestExistingMessage;
    }

    if (!incomingMessageIsNewest) {
      return {
        status: { code: 409, detail: 'Conflict' }
      };
    }

    // return Not Found if record does not exist or is already deleted
    if (newestExistingMessage === undefined || newestExistingMessage.descriptor.method === DwnMethodName.Delete) {
      return {
        status: { code: 404, detail: 'Not Found' }
      };
    }
    const recordsWrite = await RecordsWrite.getInitialWrite(existingMessages);
    const indexes = await constructIndexes(recordsDelete, recordsWrite);
    await this.messageStore.put(tenant, message, indexes);

    const messageCid = await Message.getCid(message);
    await this.eventLog.append(tenant, messageCid, indexes);

    // delete all existing messages that are not newest, except for the initial write
    await StorageController.deleteAllOlderMessagesButKeepInitialWrite(
      tenant, existingMessages, newestMessage, this.messageStore, this.dataStore, this.eventLog
    );

    const messageReply = {
      status: { code: 202, detail: 'Accepted' }
    };
    return messageReply;
  };
}

function constructAdditionalIndexes(recordsWrite: RecordsWriteMessage): Record<string, string> {
  const { protocol, protocolPath, recipient, schema, parentId, dataFormat, dateCreated } = recordsWrite.descriptor;

  const indexes:Record<string, any> = {
    protocol, protocolPath, recipient, schema, parentId, dataFormat, dateCreated,
    contextId: recordsWrite.contextId
  };

  removeUndefinedProperties(indexes);
  return indexes;
}

export async function constructIndexes(recordsDelete: RecordsDelete, recordsWrite: RecordsWriteMessage): Promise<Record<string, string>> {

  // construct records write index
  const additionalIndexes = constructAdditionalIndexes(recordsWrite);

  const message = recordsDelete.message;
  const descriptor = { ...message.descriptor };

  // NOTE: the "trick" not may not be apparent on how a query is able to omit deleted records:
  // we intentionally not add index for `isLatestBaseState` at all, this means that upon a successful delete,
  // no messages with the record ID will match any query because queries by design filter by `isLatestBaseState = true`,
  // `isLatestBaseState` for the initial delete would have been toggled to `false`
  const indexes: Record<string, any> = {
    // isLatestBaseState : "true", // intentionally showing that this index is omitted
    author: recordsDelete.author,
    ...additionalIndexes, // we add additional indexes from the RecordsWrite so we can filter for these Deletes in the EventLog
    ...descriptor
  };

  return indexes;
}

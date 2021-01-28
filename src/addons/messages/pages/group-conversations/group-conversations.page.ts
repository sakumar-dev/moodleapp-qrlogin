// (C) Copyright 2015 Moodle Pty Ltd.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { Component, OnInit, OnDestroy, ViewChild, ElementRef } from '@angular/core';
import { IonContent, IonRefresher } from '@ionic/angular';
import { CoreEventObserver, CoreEvents } from '@singletons/events';
import { CoreSites } from '@services/sites';
import {
    AddonMessagesProvider,
    AddonMessagesConversationFormatted,
    AddonMessages,
    AddonMessagesMemberInfoChangedEventData,
    AddonMessagesContactRequestCountEventData,
    AddonMessagesUnreadConversationCountsEventData,
    AddonMessagesReadChangedEventData,
    AddonMessagesUpdateConversationListEventData,
    AddonMessagesNewMessagedEventData,
    AddonMessagesOpenConversationEventData,
} from '../../services/messages';
import { AddonMessagesOffline } from '../../services/messages-offline';
import { CoreDomUtils } from '@services/utils/dom';
import { CoreUser } from '@features/user/services/user';
import { CorePushNotificationsDelegate } from '@features/pushnotifications/services/push-delegate';
import { Platform, Translate } from '@singletons';
import { Subscription } from 'rxjs';
import { CorePushNotificationsNotificationBasicData } from '@features/pushnotifications/services/pushnotifications';
import { ActivatedRoute, Params } from '@angular/router';
import { CoreUtils } from '@services/utils/utils';
import { CoreNavigator } from '@services/navigator';
import {
    AddonMessagesOfflineConversationMessagesDBRecordFormatted,
    AddonMessagesOfflineMessagesDBRecordFormatted,
} from '@addons/messages/services/database/messages';
import { AddonMessagesSettingsHandlerService } from '@addons/messages/services/handlers/settings';
import { CoreScreen } from '@services/screen';

/**
 * Page that displays the list of conversations, including group conversations.
 */
@Component({
    selector: 'page-addon-messages-group-conversations',
    templateUrl: 'group-conversations.html',
    styleUrls: ['../../messages-common.scss'],
})
export class AddonMessagesGroupConversationsPage implements OnInit, OnDestroy {

    @ViewChild(IonContent) content?: IonContent;
    @ViewChild('favlist') favListEl?: ElementRef;
    @ViewChild('grouplist') groupListEl?: ElementRef;
    @ViewChild('indlist') indListEl?: ElementRef;

    loaded = false;
    loadingMessage: string;
    selectedConversationId?: number;
    selectedUserId?: number;
    contactRequestsCount = 0;
    favourites: AddonMessagesGroupConversationOption = {
        type: undefined,
        favourites: true,
        count: 0,
        unread: 0,
        conversations: [],
    };

    group: AddonMessagesGroupConversationOption = {
        type: AddonMessagesProvider.MESSAGE_CONVERSATION_TYPE_GROUP,
        favourites: false,
        count: 0,
        unread: 0,
        conversations: [],
    };

    individual: AddonMessagesGroupConversationOption = {
        type: AddonMessagesProvider.MESSAGE_CONVERSATION_TYPE_INDIVIDUAL,
        favourites: false,
        count: 0,
        unread: 0,
        conversations: [],
    };

    typeGroup = AddonMessagesProvider.MESSAGE_CONVERSATION_TYPE_GROUP;
    currentListEl?: HTMLElement;

    protected siteId: string;
    protected currentUserId: number;
    protected conversationId?: number;
    protected discussionUserId?: number;
    protected newMessagesObserver: CoreEventObserver;
    protected pushObserver: Subscription;
    protected appResumeSubscription: Subscription;
    protected readChangedObserver: CoreEventObserver;
    protected cronObserver: CoreEventObserver;
    protected openConversationObserver: CoreEventObserver;
    protected updateConversationListObserver: CoreEventObserver;
    protected contactRequestsCountObserver: CoreEventObserver;
    protected memberInfoObserver: CoreEventObserver;

    constructor(
        protected route: ActivatedRoute,
    ) {
        this.loadingMessage = Translate.instance.instant('core.loading');
        this.siteId = CoreSites.instance.getCurrentSiteId();
        this.currentUserId = CoreSites.instance.getCurrentSiteUserId();

        // Update conversations when new message is received.
        this.newMessagesObserver = CoreEvents.on<AddonMessagesNewMessagedEventData>(
            AddonMessagesProvider.NEW_MESSAGE_EVENT,
            (data) => {
            // Check if the new message belongs to the option that is currently expanded.
                const expandedOption = this.getExpandedOption();
                const messageOption = this.getConversationOption(data);

                if (expandedOption != messageOption) {
                    return; // Message doesn't belong to current list, stop.
                }

                // Search the conversation to update.
                const conversation = this.findConversation(data.conversationId, data.userId, expandedOption);

                if (typeof conversation == 'undefined') {
                // Probably a new conversation, refresh the list.
                    this.loaded = false;
                    this.refreshData().finally(() => {
                        this.loaded = true;
                    });

                    return;
                }
                if (conversation.lastmessage != data.message || conversation.lastmessagedate != data.timecreated / 1000) {
                    const isNewer = data.timecreated / 1000 > (conversation.lastmessagedate || 0);

                    // An existing conversation has a new message, update the last message.
                    conversation.lastmessage = data.message;
                    conversation.lastmessagedate = data.timecreated / 1000;

                    // Sort the affected list.
                    const option = this.getConversationOption(conversation);
                    option.conversations = AddonMessages.instance.sortConversations(option.conversations || []);

                    if (isNewer) {
                    // The last message is newer than the previous one, scroll to top to keep viewing the conversation.
                        this.content?.scrollToTop();
                    }
                }
            },
            this.siteId,
        );

        // Update conversations when a message is read.
        this.readChangedObserver = CoreEvents.on<AddonMessagesReadChangedEventData>(AddonMessagesProvider.READ_CHANGED_EVENT, (
            data,
        ) => {
            if (data.conversationId) {
                const conversation = this.findConversation(data.conversationId);

                if (typeof conversation != 'undefined') {
                    // A conversation has been read reset counter.
                    conversation.unreadcount = 0;

                    // Conversations changed, invalidate them and refresh unread counts.
                    AddonMessages.instance.invalidateConversations(this.siteId);
                    AddonMessages.instance.refreshUnreadConversationCounts(this.siteId);
                }
            }
        }, this.siteId);

        // Load a discussion if we receive an event to do so.
        this.openConversationObserver = CoreEvents.on<AddonMessagesOpenConversationEventData>(
            AddonMessagesProvider.OPEN_CONVERSATION_EVENT,
            (data) => {
                if (data.conversationId || data.userId) {
                    this.gotoConversation(data.conversationId, data.userId);
                }
            },
            this.siteId,
        );

        // Refresh the view when the app is resumed.
        this.appResumeSubscription = Platform.instance.resume.subscribe(() => {
            if (!this.loaded) {
                return;
            }
            this.loaded = false;
            this.refreshData().finally(() => {
                this.loaded = true;
            });
        });

        // Update conversations if we receive an event to do so.
        this.updateConversationListObserver = CoreEvents.on<AddonMessagesUpdateConversationListEventData>(
            AddonMessagesProvider.UPDATE_CONVERSATION_LIST_EVENT,
            (data) => {
                if (data && data.action == 'mute') {
                // If the conversation is displayed, change its muted value.
                    const expandedOption = this.getExpandedOption();

                    if (expandedOption && expandedOption.conversations) {
                        const conversation = this.findConversation(data.conversationId, undefined, expandedOption);
                        if (conversation) {
                            conversation.ismuted = !!data.value;
                        }
                    }

                    return;
                }

                this.refreshData();

            },
            this.siteId,
        );

        // If a message push notification is received, refresh the view.
        this.pushObserver = CorePushNotificationsDelegate.instance.on<CorePushNotificationsNotificationBasicData>('receive')
            .subscribe((notification) => {
                // New message received. If it's from current site, refresh the data.
                if (CoreUtils.instance.isFalseOrZero(notification.notif) && notification.site == this.siteId) {
                // Don't refresh unread counts, it's refreshed from the main menu handler in this case.
                    this.refreshData(undefined, false);
                }
            });

        // Update unread conversation counts.
        this.cronObserver = CoreEvents.on<AddonMessagesUnreadConversationCountsEventData>(
            AddonMessagesProvider.UNREAD_CONVERSATION_COUNTS_EVENT,
            (data) => {
                this.favourites.unread = data.favourites;
                this.individual.unread = data.individual + data.self; // Self is only returned if it's not favourite.
                this.group.unread = data.group;
            },
            this.siteId,
        );

        // Update the contact requests badge.
        this.contactRequestsCountObserver = CoreEvents.on<AddonMessagesContactRequestCountEventData>(
            AddonMessagesProvider.CONTACT_REQUESTS_COUNT_EVENT,
            (data) => {
                this.contactRequestsCount = data.count;
            },
            this.siteId,
        );

        // Update block status of a user.
        this.memberInfoObserver = CoreEvents.on<AddonMessagesMemberInfoChangedEventData>(
            AddonMessagesProvider.MEMBER_INFO_CHANGED_EVENT,
            (data) => {
                if (!data.userBlocked && !data.userUnblocked) {
                // The block status has not changed, ignore.
                    return;
                }

                const expandedOption = this.getExpandedOption();
                if (expandedOption == this.individual || expandedOption == this.favourites) {
                    if (!expandedOption.conversations || expandedOption.conversations.length <= 0) {
                        return;
                    }

                    const conversation = this.findConversation(undefined, data.userId, expandedOption);
                    if (conversation) {
                        conversation.isblocked = data.userBlocked;
                    }
                }
            },
            this.siteId,
        );
    }

    /**
     * Component loaded.
     */
    ngOnInit(): void {
        this.route.queryParams.subscribe(async () => {
            // Conversation to load.
            this.conversationId = CoreNavigator.instance.getRouteNumberParam('conversationId') || undefined;
            if (!this.conversationId) {
                this.discussionUserId = CoreNavigator.instance.getRouteNumberParam('discussionUserId') || undefined;
            }

            if (this.conversationId || this.discussionUserId) {
                // There is a discussion to load, open the discussion in a new state.
                this.gotoConversation(this.conversationId, this.discussionUserId);
            }

            await this.fetchData();
            if (!this.conversationId && !this.discussionUserId && CoreScreen.instance.isTablet) {
                // Load the first conversation.
                let conversation: AddonMessagesConversationForList;
                const expandedOption = this.getExpandedOption();

                if (expandedOption && expandedOption.conversations.length) {
                    conversation = expandedOption.conversations[0];

                    if (conversation) {
                        this.gotoConversation(conversation.id);
                    }
                }
            }
        });
    }

    /**
     * Fetch conversations.
     *
     * @param refreshUnreadCounts Whether to refresh unread counts.
     * @return Promise resolved when done.
     */
    protected async fetchData(refreshUnreadCounts: boolean = true): Promise<void> {
        // Load the amount of conversations and contact requests.
        const promises: Promise<unknown>[] = [];

        promises.push(this.fetchConversationCounts());

        // View updated by the events observers.
        promises.push(AddonMessages.instance.getContactRequestsCount(this.siteId));
        if (refreshUnreadCounts) {
            promises.push(AddonMessages.instance.refreshUnreadConversationCounts(this.siteId));
        }

        try {
            await Promise.all(promises);

            // The expanded status hasn't been initialized. Do it now.
            if (typeof this.favourites.expanded == 'undefined' && this.conversationId || this.discussionUserId) {
                // A certain conversation should be opened.
                // We don't know which option it belongs to, so we need to fetch the data for all of them.
                const promises: Promise<void>[] = [];

                promises.push(this.fetchDataForOption(this.favourites, false));
                promises.push(this.fetchDataForOption(this.group, false));
                promises.push(this.fetchDataForOption(this.individual, false));

                await Promise.all(promises);
                // All conversations have been loaded, find the one we need to load and expand its option.
                const conversation = this.findConversation(this.conversationId, this.discussionUserId);
                if (conversation) {
                    const option = this.getConversationOption(conversation);

                    await this.expandOption(option);

                    this.loaded = true;

                    return;
                }
            }

            // Load the data for the expanded option.
            await this.fetchDataForExpandedOption();
        } catch (error) {
            CoreDomUtils.instance.showErrorModalDefault(error, 'addon.messages.errorwhileretrievingdiscussions', true);
        }
        this.loaded = true;
    }

    /**
     * Fetch data for the expanded option.
     *
     * @return Promise resolved when done.
     */
    protected async fetchDataForExpandedOption(): Promise<void> {
        if (typeof this.favourites.expanded == 'undefined') {
            // Calculate which option should be expanded initially.
            this.favourites.expanded = this.favourites.count != 0 && !this.group.unread && !this.individual.unread;
            this.group.expanded = !this.favourites.expanded && this.group.count != 0 && !this.individual.unread;
            this.individual.expanded = !this.favourites.expanded && !this.group.expanded;
        }

        this.loadCurrentListElement();

        const expandedOption = this.getExpandedOption();

        if (expandedOption) {
            await this.fetchDataForOption(expandedOption, false);
        }
    }

    /**
     * Fetch data for a certain option.
     *
     * @param option The option to fetch data for.
     * @param loadingMore Whether we are loading more data or just the first ones.
     * @param getCounts Whether to get counts data.
     * @return Promise resolved when done.
     */
    async fetchDataForOption(
        option: AddonMessagesGroupConversationOption,
        loadingMore = false,
        getCounts = false,
    ): Promise<void> {
        option.loadMoreError = false;

        const limitFrom = loadingMore ? option.conversations.length : 0;
        const promises: Promise<unknown>[] = [];

        let data: { conversations: AddonMessagesConversationForList[]; canLoadMore: boolean } = {
            conversations: [],
            canLoadMore: false,
        };
        let offlineMessages:
        (AddonMessagesOfflineConversationMessagesDBRecordFormatted | AddonMessagesOfflineMessagesDBRecordFormatted)[] = [];

        // Get the conversations and, if needed, the offline messages. Always try to get the latest data.
        promises.push(AddonMessages.instance.invalidateConversations(this.siteId).then(async () => {
            data = await AddonMessages.instance.getConversations(option.type, option.favourites, limitFrom, this.siteId);

            return;
        }));

        if (!loadingMore) {
            promises.push(AddonMessagesOffline.instance.getAllMessages().then((messages) => {
                offlineMessages = messages;

                return;
            }));
        }

        if (getCounts) {
            promises.push(this.fetchConversationCounts());
            promises.push(AddonMessages.instance.refreshUnreadConversationCounts(this.siteId));
        }

        await Promise.all(promises);

        if (loadingMore) {
            option.conversations = option.conversations.concat(data.conversations);
            option.canLoadMore = data.canLoadMore;
        } else {
            option.conversations = data.conversations;
            option.canLoadMore = data.canLoadMore;

            if (offlineMessages && offlineMessages.length) {
                await this.loadOfflineMessages(option, offlineMessages);

                // Sort the conversations, the offline messages could affect the order.
                option.conversations = AddonMessages.instance.sortConversations(option.conversations);
            }
        }
    }

    /**
     * Fetch conversation counts.
     *
     * @return Promise resolved when done.
     */
    protected async fetchConversationCounts(): Promise<void> {
        // Always try to get the latest data.
        await AddonMessages.instance.invalidateConversationCounts(this.siteId);

        const counts = await AddonMessages.instance.getConversationCounts(this.siteId);
        this.favourites.count = counts.favourites;
        this.individual.count = counts.individual + counts.self; // Self is only returned if it's not favourite.
        this.group.count = counts.group;
    }

    /**
     * Find a conversation in the list of loaded conversations.
     *
     * @param conversationId The conversation ID to search.
     * @param userId User ID to search (if no conversationId).
     * @param option The option to search in. If not defined, search in all options.
     * @return Conversation.
     */
    protected findConversation(
        conversationId?: number,
        userId?: number,
        option?: AddonMessagesGroupConversationOption,
    ): AddonMessagesConversationForList | undefined {

        if (conversationId) {
            const conversations: AddonMessagesConversationForList[] = option
                ? option.conversations
                : (this.favourites.conversations.concat(this.group.conversations).concat(this.individual.conversations));

            return conversations.find((conv) => conv.id == conversationId);
        }

        const conversations = option
            ? option.conversations
            : this.favourites.conversations.concat(this.individual.conversations);

        return conversations.find((conv) => conv.userid == userId);
    }

    /**
     * Get the option that is currently expanded, undefined if they are all collapsed.
     *
     * @return Option currently expanded.
     */
    protected getExpandedOption(): AddonMessagesGroupConversationOption | undefined {
        if (this.favourites.expanded) {
            return this.favourites;
        } else if (this.group.expanded) {
            return this.group;
        } else if (this.individual.expanded) {
            return this.individual;
        }
    }

    /**
     * Navigate to contacts view.
     */
    gotoContacts(): void {
        CoreNavigator.instance.navigateToSitePath('contacts');
    }

    /**
     * Navigate to a particular conversation.
     *
     * @param conversationId Conversation Id to load.
     * @param userId User of the conversation. Only if there is no conversationId.
     * @param messageId Message to scroll after loading the discussion. Used when searching.
     */
    gotoConversation(conversationId?: number, userId?: number, messageId?: number): void {
        this.selectedConversationId = conversationId;
        this.selectedUserId = userId;

        const params: Params = {};
        if (conversationId) {
            params.conversationId = conversationId;
        }
        if (userId) {
            params.userId = userId;
        }
        if (messageId) {
            params.message = messageId;
        }

        const splitViewLoaded = CoreNavigator.instance.isCurrentPathInTablet('**/messages/group-conversations/discussion');
        const path = (splitViewLoaded ? '../' : '') + 'discussion';
        CoreNavigator.instance.navigate(path, { params });
    }

    /**
     * Navigate to message settings.
     */
    gotoSettings(): void {
        CoreNavigator.instance.navigateToSitePath(AddonMessagesSettingsHandlerService.PAGE_NAME);
    }

    /**
     * Function to load more conversations.
     *
     * @param option The option to fetch data for.
     * @param infiniteComplete Infinite scroll complete function. Only used from core-infinite-loading.
     * @return Promise resolved when done.
     */
    async loadMoreConversations(option: AddonMessagesGroupConversationOption, infiniteComplete?: () => void): Promise<void> {
        try {
            await this.fetchDataForOption(option, true);
        } catch (error) {
            CoreDomUtils.instance.showErrorModalDefault(error, 'addon.messages.errorwhileretrievingdiscussions', true);
            option.loadMoreError = true;
        }

        infiniteComplete && infiniteComplete();
    }

    /**
     * Load offline messages into the conversations.
     *
     * @param option The option where the messages should be loaded.
     * @param messages Offline messages.
     * @return Promise resolved when done.
     */
    protected async loadOfflineMessages(
        option: AddonMessagesGroupConversationOption,
        messages: (AddonMessagesOfflineConversationMessagesDBRecordFormatted | AddonMessagesOfflineMessagesDBRecordFormatted)[],
    ): Promise<void> {
        const promises: Promise<void>[] = [];

        messages.forEach((message) => {
            if ('conversationid' in message) {
                // It's an existing conversation. Search it in the current option.
                let conversation = this.findConversation(message.conversationid, undefined, option);

                if (conversation) {
                    // Check if it's the last message. Offline messages are considered more recent than sent messages.
                    if (typeof conversation.lastmessage === 'undefined' || conversation.lastmessage === null ||
                            !conversation.lastmessagepending || (conversation.lastmessagedate || 0) <= message.timecreated / 1000) {

                        this.addLastOfflineMessage(conversation, message);
                    }
                } else {
                    // Conversation not found, it could be an old one or the message could belong to another option.
                    conversation = {
                        id: message.conversationid,
                        type: message.conversation?.type || AddonMessagesProvider.MESSAGE_CONVERSATION_TYPE_INDIVIDUAL,
                        membercount: message.conversation?.membercount || 0,
                        ismuted: message.conversation?.ismuted || false,
                        isfavourite: message.conversation?.isfavourite || false,
                        isread: message.conversation?.isread || false,
                        members: message.conversation?.members || [],
                        messages: message.conversation?.messages || [],
                        candeletemessagesforallusers: message.conversation?.candeletemessagesforallusers || false,
                        userid: 0, // Faked data.
                        name: message.conversation?.name,
                        imageurl: message.conversation?.imageurl || '',
                    }; message.conversation || {};

                    if (this.getConversationOption(conversation) == option) {
                        // Message belongs to current option, add the conversation.
                        this.addLastOfflineMessage(conversation, message);
                        this.addOfflineConversation(conversation);
                    }
                }
            } else if (option.type == AddonMessagesProvider.MESSAGE_CONVERSATION_TYPE_INDIVIDUAL) {
                // It's a new conversation. Check if we already created it (there is more than one message for the same user).
                const conversation = this.findConversation(undefined, message.touserid, option);

                message.text = message.smallmessage;

                if (conversation) {
                    // Check if it's the last message. Offline messages are considered more recent than sent messages.
                    if ((conversation.lastmessagedate || 0) <= message.timecreated / 1000) {
                        this.addLastOfflineMessage(conversation, message);
                    }
                } else {
                    // Get the user data and create a new conversation if it belongs to the current option.
                    promises.push(CoreUser.instance.getProfile(message.touserid, undefined, true).catch(() => {
                        // User not found.
                    }).then((user) => {
                        const conversation: AddonMessagesConversationForList = {
                            id: 0,
                            type: AddonMessagesProvider.MESSAGE_CONVERSATION_TYPE_INDIVIDUAL,
                            membercount: 0, // Faked data.
                            ismuted: false, // Faked data.
                            isfavourite: false, // Faked data.
                            isread: false, // Faked data.
                            members: [], // Faked data.
                            messages: [], // Faked data.
                            candeletemessagesforallusers: false,
                            userid: message.touserid,
                            name: user ? user.fullname : String(message.touserid),
                            imageurl: user ? user.profileimageurl : '',
                        };

                        this.addLastOfflineMessage(conversation, message);
                        this.addOfflineConversation(conversation);

                        return;
                    }));
                }
            }
        });

        await Promise.all(promises);
    }

    /**
     * Add an offline conversation into the right list of conversations.
     *
     * @param conversation Offline conversation to add.
     */
    protected addOfflineConversation(conversation: AddonMessagesConversationForList): void {
        const option = this.getConversationOption(conversation);
        option.conversations.unshift(conversation);
    }

    /**
     * Add a last offline message into a conversation.
     *
     * @param conversation Conversation where to put the last message.
     * @param message Offline message to add.
     */
    protected addLastOfflineMessage(
        conversation: AddonMessagesConversationForList,
        message: AddonMessagesOfflineConversationMessagesDBRecordFormatted | AddonMessagesOfflineMessagesDBRecordFormatted,
    ): void {
        conversation.lastmessage = message.text;
        conversation.lastmessagedate = message.timecreated / 1000;
        conversation.lastmessagepending = true;
        conversation.sentfromcurrentuser = true;
    }

    /**
     * Given a conversation, return its option (favourites, group, individual).
     *
     * @param conversation Conversation to check.
     * @return Option object.
     */
    protected getConversationOption(
        conversation: AddonMessagesConversationForList | AddonMessagesNewMessagedEventData,
    ): AddonMessagesGroupConversationOption {
        if (conversation.isfavourite) {
            return this.favourites;
        }

        if (conversation.type == AddonMessagesProvider.MESSAGE_CONVERSATION_TYPE_GROUP) {
            return this.group;
        }

        return this.individual;
    }

    /**
     * Refresh the data.
     *
     * @param refresher Refresher.
     * @param refreshUnreadCounts Whether to refresh unread counts.
     * @return Promise resolved when done.
     */
    async refreshData(refresher?: CustomEvent<IonRefresher>, refreshUnreadCounts: boolean = true): Promise<void> {
        // Don't invalidate conversations and so, they always try to get latest data.
        try {
            await AddonMessages.instance.invalidateContactRequestsCountCache(this.siteId);
        } finally {
            try {
                await this.fetchData(refreshUnreadCounts);
            } finally {
                if (refresher) {
                    refresher?.detail.complete();
                }
            }
        }
    }

    /**
     * Toogle the visibility of an option (expand/collapse).
     *
     * @param option The option to expand/collapse.
     */
    toggle(option: AddonMessagesGroupConversationOption): void {
        if (option.expanded) {
            // Already expanded, close it.
            option.expanded = false;
            this.loadCurrentListElement();
        } else {
            // Pass getCounts=true to update the counts everytime the user expands an option.
            this.expandOption(option, true).catch((error) => {
                CoreDomUtils.instance.showErrorModalDefault(error, 'addon.messages.errorwhileretrievingdiscussions', true);
            });
        }
    }

    /**
     * Expand a certain option.
     *
     * @param option The option to expand.
     * @param getCounts Whether to get counts data.
     * @return Promise resolved when done.
     */
    protected async expandOption(option: AddonMessagesGroupConversationOption, getCounts = false): Promise<void> {
        // Collapse all and expand the right one.
        this.favourites.expanded = false;
        this.group.expanded = false;
        this.individual.expanded = false;

        option.expanded = true;
        option.loading = true;

        try {
            await this.fetchDataForOption(option, false, getCounts);

            this.loadCurrentListElement();
        } catch (error) {
            option.expanded = false;

            throw error;
        } finally {
            option.loading = false;
        }

    }

    /**
     * Load the current list element based on the expanded list.
     */
    protected loadCurrentListElement(): void {
        if (this.favourites.expanded) {
            this.currentListEl = this.favListEl && this.favListEl.nativeElement;
        } else if (this.group.expanded) {
            this.currentListEl = this.groupListEl && this.groupListEl.nativeElement;
        } else if (this.individual.expanded) {
            this.currentListEl = this.indListEl && this.indListEl.nativeElement;
        } else {
            this.currentListEl = undefined;
        }
    }

    /**
     * Navigate to the search page.
     */
    gotoSearch(): void {
        CoreNavigator.instance.navigateToSitePath('search');
    }

    /**
     * Page destroyed.
     */
    ngOnDestroy(): void {
        this.newMessagesObserver?.off();
        this.appResumeSubscription?.unsubscribe();
        this.pushObserver?.unsubscribe();
        this.readChangedObserver?.off();
        this.cronObserver?.off();
        this.openConversationObserver?.off();
        this.updateConversationListObserver?.off();
        this.contactRequestsCountObserver?.off();
        this.memberInfoObserver?.off();
    }

}

/**
 * Conversation options.
 */
export type AddonMessagesGroupConversationOption = {
    type?: number; // Option type.
    favourites: boolean; // Whether it contains favourites conversations.
    count: number; // Number of conversations.
    unread?: number; // Number of unread conversations.
    expanded?: boolean; // Whether the option is currently expanded.
    loading?: boolean; // Whether the option is being loaded.
    canLoadMore?: boolean; // Whether it can load more data.
    loadMoreError?: boolean; // Whether there was an error loading more conversations.
    conversations: AddonMessagesConversationForList[]; // List of conversations.
};

/**
 * Formatted conversation with some calculated data for the list.
 */
export type AddonMessagesConversationForList = AddonMessagesConversationFormatted & {
    lastmessagepending?: boolean; // Calculated in the app. Whether last message is pending to be sent.
};

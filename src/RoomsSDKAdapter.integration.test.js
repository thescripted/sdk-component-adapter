import {createIntegrationTestUser, removeIntegrationTestUser} from './testHelper';

import WebexSDKAdapter from './';

describe('Rooms SDK Adapter', () => {
  let createdRoom, getRoom$, webexSDKAdapter, subscription, user;

  // Since these are integration tests with live data,
  // increase the async "idle" timeout so jest doesn't error early.
  jest.setTimeout(30000);

  beforeAll(async () => {
    user = await createIntegrationTestUser();
    webexSDKAdapter = new WebexSDKAdapter(user.sdk);
    await webexSDKAdapter.connect();
  });

  afterAll(async () => {
    try {
      await removeIntegrationTestUser(user);
      await webexSDKAdapter.disconnect();
    } catch (reason) {
      // eslint-disable-next-line no-console
      console.warn('Failed to delete test user for Room SDK Adapter integration tests.', reason);
    }
  });

  describe('getRoom() returns', () => {
    beforeEach(async () => {
      createdRoom = await user.sdk.rooms.create({title: 'Webex Teams Test Room'});
      getRoom$ = webexSDKAdapter.roomsAdapter.getRoom(createdRoom.id);
    });

    afterEach(async () => {
      try {
        await user.sdk.rooms.remove(createdRoom.id);
        subscription.unsubscribe();
        getRoom$ = null;
        createdRoom = null;
      } catch (reason) {
        // eslint-disable-next-line no-console
        console.warn(`Failed to delete a room "${createdRoom.id}" in Room SDK Adapter integration tests.`, reason);
      }
    });

    test('a room in a proper shape', async (done) => {
      subscription = getRoom$.subscribe((room) => {
        expect(room).toMatchObject({
          ID: createdRoom.id,
          title: createdRoom.title,
        });
        done();
      });
    });

    test('an updated room title after subscribing', async (done) => {
      let hasUpdated = false;
      const updatedTitle = 'Updated Test Title';

      subscription = getRoom$.subscribe(async (room) => {
        // The first subscription event will be the current state of the room.
        if (!hasUpdated) {
          // Update the room title so we get another subscription event.
          await user.sdk.rooms.update({id: room.ID, title: updatedTitle});
          hasUpdated = true;
        } else {
          // Once we've updated the title, the next event should include the updated title.
          expect(room.title).toBe(updatedTitle);
          done();
        }
      });
    });

    test('support for multiple subscriptions', async (done) => {
      subscription = getRoom$.subscribe();

      const secondSubscription = getRoom$.subscribe((room) => {
        expect(room).toMatchObject({
          ID: createdRoom.id,
          title: createdRoom.title,
        });
        done();
      });

      subscription.add(secondSubscription);
    });
  });
});
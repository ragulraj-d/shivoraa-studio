/**
 * Firebase initialisation.
 *
 * The whole backend for this deployment: Auth for identity, Firestore for data.
 * Both are free on the Spark plan, so there is no server to run and no bill.
 *
 * These values are public by design — they identify the project, they do not
 * authorise anything. Access is decided entirely by firestore.rules, which is
 * why those rules are the security boundary rather than an afterthought.
 */

import { initializeApp, type FirebaseApp } from 'firebase/app'
import {
  browserLocalPersistence,
  getAuth,
  setPersistence,
  type Auth,
} from 'firebase/auth'
import { getFirestore, type Firestore } from 'firebase/firestore'

const config = {
  projectId: 'shivoraa',
  appId: '1:645652639735:web:84ae656679f5bb8c2448f2',
  databaseURL: 'https://shivoraa-default-rtdb.firebaseio.com',
  storageBucket: 'shivoraa.firebasestorage.app',
  apiKey: 'AIzaSyBNkP1uhg9vELIU73Y4gYSZsgTIMQfzFQA',
  authDomain: 'shivoraa.firebaseapp.com',
  messagingSenderId: '645652639735',
  projectNumber: '645652639735',
  version: '2',
}

let app: FirebaseApp | null = null
let authInstance: Auth | null = null
let dbInstance: Firestore | null = null

function ensure(): FirebaseApp {
  if (!app) app = initializeApp(config)
  return app
}

export function auth(): Auth {
  if (!authInstance) {
    authInstance = getAuth(ensure())
    // Survive a page reload without asking the user to sign in again.
    void setPersistence(authInstance, browserLocalPersistence)
  }
  return authInstance
}

export function db(): Firestore {
  if (!dbInstance) dbInstance = getFirestore(ensure())
  return dbInstance
}

export const FIREBASE_PROJECT = config.projectId

plugins {
    id("com.android.application")
}

android {
    namespace = "com.osfh.chatwrapper"
    compileSdk = 35

    signingConfigs {
        create("osfhPrototype") {
            storeFile = file("../osfh-prototype.jks")
            storePassword = "osfhprototype2026"
            keyAlias = "osfh"
            keyPassword = "osfhprototype2026"
        }
    }

    defaultConfig {
        applicationId = "com.osfh.chatwrapper"
        minSdk = 26
        targetSdk = 35
        versionCode = 3
        versionName = "0.2.1"
    }

    buildTypes {
        getByName("debug") {
            signingConfig = signingConfigs.getByName("osfhPrototype")
        }
    }
}

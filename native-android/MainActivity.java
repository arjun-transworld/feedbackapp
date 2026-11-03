package com.transworld.jets.feedback;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

/** Replaces the generated MainActivity: registers our in-app plugin before Capacitor starts. */
public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(BackgroundUploadPlugin.class);
        super.onCreate(savedInstanceState);
    }
}

import Capacitor

/// Registers our in-app plugin with Capacitor.
/// In Main.storyboard, set the Bridge View Controller's custom class to MainViewController.
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(BackgroundUploadPlugin())
    }
}
